import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitIn, ORCHESTRATOR_GIT_IDENTITY } from '@slave-of-ai/control'
import {
  COMMAND_OUTPUT_LIMIT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  commandFailure,
  runShellCommand,
} from './shell.js'

/**
 * Kept as an alias rather than renamed at every call site: this is the name the provisioning
 * behaviour is documented and tested under, and the limit itself now belongs to `shell.ts` because
 * verify needs exactly the same one.
 */
export const SETUP_OUTPUT_LIMIT = COMMAND_OUTPUT_LIMIT

/**
 * Where worktrees live, relative to the workspace's repository root (spec §7.1). Inside the repo
 * rather than in a temp directory: a worktree is the inspection surface for a failed run (§7.4),
 * and an operator looking at why a task failed should find it next to the code, not have to be
 * told a path under `/tmp` that a reboot may already have taken away.
 */
const WORKTREE_ROOT = join('.slaveofai', 'worktrees')

/**
 * Moved to `@slave-of-ai/control` in M23 B2 (`packages/control/src/git.ts`): `collectTaskWorktree`
 * needs the identical identity-scoped git wrapper this module already runs every other worktree
 * command through, and `packages/control` cannot depend on `apps/orchestrator`. Re-exported here
 * (`review.ts` and `merge.ts` still import `gitIn` from this module) so this module's own uses
 * below (`gitIn`, `ORCHESTRATOR_GIT_IDENTITY.name`/`.email`) need no changes either.
 */
export { gitIn, ORCHESTRATOR_GIT_IDENTITY }

/**
 * Task keys and slugs both become path segments and part of a branch name. `join()` collapses
 * `..`, so an unchecked key of `../../../../tmp/x` places the worktree outside the repository
 * entirely, and a value starting with `-` reaches git's argv where it parses as an option. Neither
 * is hypothetical: `Task` has no key column, so whatever Task 13 passes is synthesized -- plausibly
 * from a human-written title.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Makes `.slaveofai/` ignore itself inside the operator's repository.
 *
 * The orchestrator writes worktrees, settings files and pause flags into the workspace's own repo,
 * and nothing in that repo asks for them. Without this, `git status` there shows the orchestrator's
 * bookkeeping as untracked content forever, and a `git clean -fdx` -- a routine operator action --
 * deletes every worktree directory while `.git/worktrees/` metadata survives, leaving
 * `git worktree list` describing directories that no longer exist.
 *
 * A `.gitignore` *inside* the directory rather than a line appended to the repo's own: it needs no
 * permission to edit a file the operator maintains, and it disappears with the directory.
 */
function ensureIgnored(repoPath: string): void {
  const root = join(repoPath, '.slaveofai')
  mkdirSync(root, { recursive: true })
  const marker = join(root, '.gitignore')
  if (!existsSync(marker)) writeFileSync(marker, '*\n')
}

export interface ProvisionWorktreeInput {
  readonly repoPath: string
  readonly baseBranch: string
  readonly taskKey: string
  readonly slug: string
  readonly setupCommands: readonly string[]
  /** Per-command, not for the list as a whole. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  readonly setupTimeoutMs?: number
}

export interface WorktreeHandle {
  readonly path: string
  readonly branch: string
  /**
   * The worktree's `HEAD` once provisioning is complete -- read *after* the setup commands, not
   * before. Setup is arbitrary shell (spec §7.2) and a workspace is free to have it commit; this
   * field is meant to answer "what did the run actually start from", which is only true of a
   * commit read at the end.
   */
  readonly headCommit: string
}

/**
 * Thrown when the task's worktree or branch is already there.
 *
 * This is a *distinguishable* outcome rather than a raw git failure because it is not an error
 * condition at all from the caller's side -- it is the normal shape of a task's second run. A task
 * that fails verify moves to `rework`, `decide()` lists `rework` as startable, and the next run
 * arrives here with the same key. Refusing is right: reusing a previous attempt's directory hands
 * the slave someone else's uncommitted state. But the adopt-versus-fail decision needs to know
 * *why* the leftovers exist, which only the caller does, and it must not be made by string-matching
 * git's stderr -- git reports the path collision and the branch collision with different exit codes
 * and different wording.
 *
 * Carries both paths so the caller can act without re-deriving them.
 */
export class WorktreeExistsError extends Error {
  constructor(
    readonly path: string,
    readonly branch: string,
    /**
     * Which half is there, as a field rather than as wording inside `message`.
     *
     * The caller's two cases live exactly here. `both` is the shape this task's own previous
     * attempt leaves: directory and branch, matching, which is what a task returning from
     * `rework` finds and the only case where adopting is defensible. `directory` alone is a
     * stray tree with nothing behind it and `branch` alone is the residue of a half-finished
     * removal -- neither is something a completed provision produced, so neither is safe to
     * adopt. Collapsing them (by short-circuiting the second check) would hand the caller the
     * adoptable case and the wreckage under one name.
     */
    readonly reason: 'directory' | 'branch' | 'both',
  ) {
    super(`worktree for this task already exists (${reason}): ${path} on ${branch}`)
    this.name = 'WorktreeExistsError'
  }
}

/** True when the ref exists. `show-ref --verify` exits non-zero rather than printing when it does not. */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await gitIn(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/**
 * The environment setup commands run under. Carries the same git identity variables the adapter
 * gives a run (§7.3 layer 1, `buildChildEnv` in `packages/providers`): setup is arbitrary shell
 * that a real workspace may well have commit something, and a setup command that hits git's
 * missing-identity error is exactly the situation whose "helpful" recovery was an unscoped
 * `git config` write into the shared common directory.
 */
function setupEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: ORCHESTRATOR_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: ORCHESTRATOR_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: ORCHESTRATOR_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: ORCHESTRATOR_GIT_IDENTITY.email,
  }
}

/**
 * Creates the task's worktree on its own branch off `baseBranch`, runs the workspace's setup
 * commands inside it, and reports where it landed (spec §7.1, §7.2).
 *
 * The worktree is **not** cleaned up when a setup command fails. Spec §7.4 preserves worktrees on
 * failure because they are the inspection surface, and a half-provisioned one is the case where
 * that matters most: the operator's question is "how far did setup get", which a removed directory
 * cannot answer. Task 15's sweep owns collection.
 *
 * Leftovers from a previous attempt are refused, not adopted, and refused as a
 * {@link WorktreeExistsError} the caller can branch on -- see that class for why the decision is
 * the caller's. One half-state is deliberately left to git: a `.git/worktrees/` metadata entry
 * whose directory *and* branch are both gone still makes `worktree add` refuse, and it surfaces as
 * git's own error. It is what a `git worktree prune` exists for and is not this function's to
 * silently repair.
 */
export async function provisionWorktree(input: ProvisionWorktreeInput): Promise<WorktreeHandle> {
  for (const [field, value] of [
    ['taskKey', input.taskKey],
    ['slug', input.slug],
  ] as const) {
    if (!SAFE_SEGMENT.test(value)) {
      throw new Error(
        `${field} must match ${String(SAFE_SEGMENT)} to be safe as a path segment and a branch name, got: ${value}`,
      )
    }
  }

  // Absolute, because `path` becomes `SlaveRun.worktreePath` and spec §5.7 respawns a resumed run
  // there -- from a process that may have restarted into a different working directory.
  const repoPath = resolve(input.repoPath)
  ensureIgnored(repoPath)
  const path = join(repoPath, WORKTREE_ROOT, input.taskKey)
  const branch = `slaveofai/${input.taskKey}-${input.slug}`

  // Checked *before* the add rather than left to git's refusal, because `worktree add -b` creates
  // the branch first and then fails on the path -- measured -- so letting git refuse leaves a
  // branch behind with no worktree attached, and the next attempt fails differently than this one.
  // Both halves are evaluated before either is reported: which of them is present is the caller's
  // whole decision (see WorktreeExistsError.reason), and a short-circuit here would answer
  // "directory" for the rework case and for a stray tree alike.
  const hasDirectory = existsSync(path)
  const hasBranch = await branchExists(repoPath, branch)
  if (hasDirectory || hasBranch) {
    const reason = hasDirectory && hasBranch ? 'both' : hasDirectory ? 'directory' : 'branch'
    throw new WorktreeExistsError(path, branch, reason)
  }

  // `worktree add -b` creates the branch and the leading directories in one step.
  await gitIn(repoPath, 'worktree', 'add', '-b', branch, path, input.baseBranch)

  // Sequential, and aborting on the first failure: setup commands are an ordered list whose later
  // entries routinely depend on earlier ones (`npm ci` then `npm run build`), so running on after
  // a failure produces a second, misleading error from the wrong command.
  const timeoutMs = input.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  for (const command of input.setupCommands) {
    // A spawn that never starts (a vanished cwd, no `/bin/sh`) rejects with a bare Node error,
    // and Task 13 persists whatever lands here as the run's `run.failed` reason. Wrapped so that
    // reason still names the command rather than reading as an orchestrator crash.
    const outcome = await runShellCommand({ command, cwd: path, timeoutMs, env: setupEnv() }).catch((cause: unknown) => {
      throw new Error(`setup command could not start: ${command}`, { cause })
    })
    if (outcome.timedOut || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`setup ${commandFailure(command, timeoutMs, outcome).message}`)
    }
  }

  const headCommit = await gitIn(path, 'rev-parse', 'HEAD')

  return { path, branch, headCommit }
}

export interface AdoptWorktreeInput {
  readonly repoPath: string
  readonly taskKey: string
  readonly branch: string
  /**
   * Re-run on adoption, not skipped. The commonest route to an adoptable worktree is a setup
   * command that *failed* -- that is exactly what leaves a half-provisioned tree behind for §7.4 to
   * preserve -- so adopting without re-running setup starts an slave in a tree with no
   * `node_modules`, which then fails verify for reasons that have nothing to do with its work.
   * Setup lists are expected to be idempotent (`npm ci` is), which is what makes re-running safe.
   */
  readonly setupCommands: readonly string[]
  /** Per command, as in {@link ProvisionWorktreeInput}. */
  readonly setupTimeoutMs?: number
}

/**
 * Takes over a worktree a previous attempt of the same task left behind, after **verifying** that
 * it is what it claims to be.
 *
 * This is the other half of {@link WorktreeExistsError}: `provisionWorktree` refuses leftovers
 * because it cannot know why they exist, and the caller — which does — comes back here when the
 * answer is "the previous run of this task". A task that fails verify moves to `rework`, and the
 * branch is where that attempt's work lives, so continuing on it is the point rather than a
 * concession.
 *
 * The verification is the reason this function exists at all rather than the caller simply reusing
 * the path. `existsSync` matches any directory; only `git worktree list` can say that *this* path
 * is a registered worktree checked out on *that* branch. Adopting an unverified directory would
 * hand the slave a tree with someone else's contents and no branch behind it.
 *
 * It lives here rather than at the call site because it needs {@link WORKTREE_ROOT}, the branch
 * naming rule and the identity-scoped `git` wrapper — re-deriving those one module over is how a
 * second source of truth for a path starts.
 */
export async function adoptWorktree(input: AdoptWorktreeInput): Promise<WorktreeHandle> {
  const repoPath = resolve(input.repoPath)
  const path = join(repoPath, WORKTREE_ROOT, input.taskKey)

  // `--porcelain` emits one blank-line-separated record per worktree, each a set of `key value`
  // lines: `worktree <path>`, `HEAD <sha>`, and `branch refs/heads/<name>` (absent when detached).
  const records = (await gitIn(repoPath, 'worktree', 'list', '--porcelain')).split('\n\n')
  const registered = records.find((record) => record.startsWith(`worktree ${path}\n`))
  if (registered === undefined) {
    throw new Error(`refusing to adopt ${path}: it is not a registered worktree of ${repoPath}`)
  }
  // Line equality, not `includes`: `branch refs/heads/x-extra` contains `branch refs/heads/x`, so
  // a substring test adopts a worktree checked out on a *longer-named* branch and then returns a
  // handle asserting the branch it was asked about -- which the caller writes onto the task. That
  // is precisely the confusion this function exists to prevent.
  if (!registered.split('\n').includes(`branch refs/heads/${input.branch}`)) {
    throw new Error(
      `refusing to adopt ${path}: it is registered, but not on ${input.branch} -- ` +
        'adopting it would hand the run a branch that belongs to something else',
    )
  }

  const timeoutMs = input.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  for (const command of input.setupCommands) {
    const outcome = await runShellCommand({ command, cwd: path, timeoutMs, env: setupEnv() })
    if (outcome.timedOut || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`setup ${commandFailure(command, timeoutMs, outcome).message}`)
    }
  }

  return { path, branch: input.branch, headCommit: await gitIn(path, 'rev-parse', 'HEAD') }
}
