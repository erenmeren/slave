import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
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
 * Where worktrees live: OUTSIDE the workspace's repository, in a sibling directory
 * `<parent>/<repo>-slaveofai-worktrees/<taskKey>` (spec §7.1), or under
 * `$SLAVEOFAI_WORKTREE_ROOT/<repo>-<hash>/<taskKey>` when that is set.
 *
 * Next to the repo rather than in a temp directory: a worktree is the inspection surface for a
 * failed run (§7.4), and an operator looking at why a task failed should find it next to the code,
 * not have to be told a path under `/tmp` that a reboot may already have taken away.
 *
 * NOT INSIDE IT, and with no dot-prefixed segment of Slave's own (2026-09-26). Until then this was
 * `<repo>/.slaveofai/worktrees/<taskKey>`, and a great deal of tooling skips any path with a dot
 * segment in it. A `biome.json` that ignores `.*` at any depth is the recorded case (fb55/css-what,
 * fb55/domutils): inside a Slave worktree `biome check .` processed no files and exited 1, so the
 * repo's own verify failed on every task while the same command passed in a normal clone. The
 * state root (`packages/control/src/paths.ts`) is no answer either: its default is under `~/.local`.
 *
 * The override's segment carries a hash of the repository path because the override is ONE
 * directory for every repository on the machine, and two repos with the same basename must not
 * share a task-key namespace -- {@link discardStaleWorktree} removes whatever sits at a key's path.
 * A leading dot is stripped from the basename in both forms, or a repo called `.dotfiles` would
 * bring the problem straight back.
 */
export function worktreeRootFor(repoPath: string): string {
  const repo = resolve(repoPath)
  const name = basename(repo).replace(/^\.+/, '') || 'repo'
  const override = process.env['SLAVEOFAI_WORKTREE_ROOT']
  if (override !== undefined && override !== '') {
    const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8)
    return join(resolve(override), `${name}-${hash}`)
  }
  return join(dirname(repo), `${name}-slaveofai-worktrees`)
}

/**
 * The OLD root, `<repo>/.slaveofai/worktrees`, which only a worktree created before 2026-09-26 is
 * under. Never provisioned into again, but still looked for: a live project has paused and
 * rework-bound tasks whose trees are there. Every path already recorded (`SlaveRun.worktreePath`,
 * `Checkpoint.worktreePath`) keeps working on its own -- resume, verify, review, merge and collect
 * all use the stored path -- so the only readers of this are the functions below that DERIVE a
 * path from a task key.
 */
export function legacyWorktreeRootFor(repoPath: string): string {
  return join(resolve(repoPath), '.slaveofai', 'worktrees')
}

/**
 * Where THIS task's worktree is: the legacy location when a directory for the key is already there,
 * the current one otherwise. One answer for provision, adopt, discard and reattach, so a rework
 * finds its own previous tree wherever it was made, and a stale legacy directory is repaired where
 * it lies rather than shadowed by a fresh one while its branch stays checked out underneath it.
 */
function locateWorktree(repoPath: string, taskKey: string): { readonly root: string; readonly path: string } {
  const legacyRoot = legacyWorktreeRootFor(repoPath)
  if (existsSync(join(legacyRoot, taskKey))) return { root: legacyRoot, path: join(legacyRoot, taskKey) }
  const root = worktreeRootFor(repoPath)
  return { root, path: join(root, taskKey) }
}

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
 * The orchestrator writes verify artifacts (and, before 2026-09-26, worktrees) into the workspace's
 * own repo, and nothing in that repo asks for them. Without this, `git status` there shows the
 * orchestrator's bookkeeping as untracked content forever, and a `git clean -fdx` -- a routine
 * operator action -- deletes every old in-repo worktree directory while `.git/worktrees/` metadata
 * survives, leaving `git worktree list` describing directories that no longer exist. Kept for both
 * reasons: artifacts still land here, and the trees made before the move still live here.
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
     * The caller's three cases live exactly here. `both` is the shape this task's own previous
     * attempt leaves: directory and branch, matching, which is what a task returning from
     * `rework` finds and the only case where ADOPTING is defensible. `directory` alone is a
     * stray tree with nothing behind it and `branch` alone is the residue of a half-finished
     * removal -- neither is something a completed provision produced, so neither is adopted:
     * since E R6 the caller REPAIRS them instead, through {@link discardStaleWorktree} and
     * {@link reattachWorktree}, which is a different decision from handing a worker a tree.
     * Collapsing them (by short-circuiting the second check) would hand the caller the adoptable
     * case and the wreckage under one name.
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
  const { path } = locateWorktree(repoPath, input.taskKey)
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

/**
 * A DETACHED checkout of `ref` at `<worktreeRoot>/<key>`, with the workspace's setup commands run
 * in it (Conductor Plan 4b, D12): the verification run's fresh worktree of a goal version's
 * integration branch. Detached, not on the branch: the integration branch stays checked out only in
 * Plan 4a's integration worktree, and git refuses a second checkout of a branch anyway.
 *
 * `ref` is resolved to a commit BEFORE the add and that commit is what is checked out, so
 * `refCommit` is exactly the tip being verified even if the branch moves during the add.
 * `headCommit` is read after setup, `provisionWorktree`'s rule. An existing path is refused, never
 * adopted: a fresh checkout is the point. On a setup failure the worktree is left for the caller to
 * remove (`removeVerificationWorktree`), which knows the path from the key.
 */
export async function provisionDetachedWorktree(input: {
  readonly repoPath: string
  readonly ref: string
  readonly key: string
  readonly setupCommands: readonly string[]
  readonly setupTimeoutMs?: number
}): Promise<{ readonly path: string; readonly headCommit: string; readonly refCommit: string }> {
  if (!SAFE_SEGMENT.test(input.key)) {
    throw new Error(`key must match ${String(SAFE_SEGMENT)} to be safe as a path segment, got: ${input.key}`)
  }
  const repoPath = resolve(input.repoPath)
  const path = join(worktreeRootFor(repoPath), input.key)
  if (existsSync(path)) throw new Error(`refusing to provision ${path}: something is already there`)

  // `--end-of-options` keeps a ref that starts with `-` from being read as an option.
  const refCommit = await gitIn(repoPath, 'rev-parse', '--verify', '--end-of-options', `${input.ref}^{commit}`)
  await gitIn(repoPath, 'worktree', 'add', '--detach', path, refCommit)

  const timeoutMs = input.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  for (const command of input.setupCommands) {
    const outcome = await runShellCommand({ command, cwd: path, timeoutMs, env: setupEnv() }).catch((cause: unknown) => {
      throw new Error(`setup command could not start: ${command}`, { cause })
    })
    if (outcome.timedOut || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`setup ${commandFailure(command, timeoutMs, outcome).message}`)
    }
  }

  return { path, headCommit: await gitIn(path, 'rev-parse', 'HEAD'), refCommit }
}

export interface AdoptWorktreeInput {
  readonly repoPath: string
  readonly taskKey: string
  readonly branch: string
  /**
   * Re-run on adoption, not skipped. The commonest route to an adoptable worktree is a setup
   * command that *failed* -- that is exactly what leaves a half-provisioned tree behind for §7.4 to
   * preserve -- so adopting without re-running setup starts a slave in a tree with no
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
 * It lives here rather than at the call site because it needs {@link locateWorktree}, the branch
 * naming rule and the identity-scoped `git` wrapper — re-deriving those one module over is how a
 * second source of truth for a path starts.
 */
export async function adoptWorktree(input: AdoptWorktreeInput): Promise<WorktreeHandle> {
  const repoPath = resolve(input.repoPath)
  const { path } = locateWorktree(repoPath, input.taskKey)

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

/**
 * Throws away a worktree DIRECTORY that has no branch behind it, so the task can be provisioned
 * again (spec E R6, fix round 1).
 *
 * The half-state this repairs is `WorktreeExistsError`'s `directory`: a path where a worktree
 * belongs, with nothing checked out on the branch that path's name implies. It cannot be a
 * completed provision -- `worktree add -b` makes the branch first (see {@link provisionWorktree}'s
 * own note on why the collision is checked before the add) -- so there is no committed work in it
 * to preserve and nothing for §7.4 to show an operator. Parking the task on it burns an attempt on
 * wreckage, which is exactly how the by-hand retry on 2026-09-20 died.
 *
 * The path is DERIVED here, from {@link locateWorktree} and a key this module re-validates, and
 * then checked to be inside that worktrees directory before anything is removed. Nothing recursive
 * is ever run against a path a caller handed in: this function takes a key, not a path, precisely
 * so there is no argument that could name the repository root.
 *
 * `git worktree prune` afterwards, not before: removing the directory is what makes the metadata
 * entry (if any) stale, and prune is git's own verb for exactly that -- it drops registrations
 * whose directories are gone and touches no branch and no file.
 *
 * IT SAYS SO FIRST (final review, Minor 5). A recursive remove is the loudest thing this module
 * does and it happened silently, inside a retry a person did not ask for -- so an operator
 * wondering where a half-finished tree went had nothing but the absence to read. One line on
 * stderr, the daemon's own channel for what it is about to do, naming the path before it goes.
 */
export async function discardStaleWorktree(input: {
  readonly repoPath: string
  readonly taskKey: string
}): Promise<void> {
  if (!SAFE_SEGMENT.test(input.taskKey)) {
    throw new Error(`taskKey must match ${String(SAFE_SEGMENT)} to be safe as a path segment, got: ${input.taskKey}`)
  }
  const repoPath = resolve(input.repoPath)
  const { root, path } = locateWorktree(repoPath, input.taskKey)
  // Belt and braces over the check above: `join` collapses `..`, so this is what would actually
  // catch a key that escaped the pattern. A removal outside the worktrees directory is a bug in
  // this module, and it refuses rather than deletes.
  if (!path.startsWith(root + sep)) {
    throw new Error(`refusing to remove ${path}: it is not inside ${root}`)
  }
  process.stderr.write(`discarding a worktree directory with no branch behind it: ${path}\n`)
  rmSync(path, { recursive: true, force: true })
  await gitIn(repoPath, 'worktree', 'prune')
}

/**
 * Puts a worktree back on a BRANCH that outlived its directory (spec E R6, fix round 1).
 *
 * The mirror image of {@link discardStaleWorktree}: `WorktreeExistsError`'s `branch` is the residue
 * of a half-finished removal -- a directory taken away (by an operator, a `git clean -fdx`, a
 * reboot that emptied a tmpfs) with the branch it was checked out on still there. The branch is
 * derived from the task's own key, so it can belong to nothing else, and it is where that attempt's
 * work lives: re-attaching to it is the same judgement {@link adoptWorktree} makes about `both`,
 * and refusing costs the task an attempt for a state nobody chose.
 *
 * `adoptWorktree` cannot serve this case -- it verifies against `git worktree list`, and a
 * registration is precisely what is missing here -- so this adds the worktree rather than taking
 * one over: `worktree add <path> <branch>`, with no `-b`, which is the one form that checks out an
 * existing branch.
 *
 * Setup runs again for {@link AdoptWorktreeInput}`.setupCommands`' reason: a tree with no
 * `node_modules` fails verify for reasons that have nothing to do with the work.
 */
export async function reattachWorktree(input: AdoptWorktreeInput): Promise<WorktreeHandle> {
  const repoPath = resolve(input.repoPath)
  ensureIgnored(repoPath)
  // The directory is gone by definition, so this is always the CURRENT root: a legacy tree whose
  // directory was lost comes back outside the repository, after the prune below has dropped its
  // old registration.
  const { path } = locateWorktree(repoPath, input.taskKey)

  // A directory that is gone may still be REGISTERED (`.git/worktrees/<key>/`), and `worktree add`
  // refuses a path git still believes in. Prune is git's verb for that and drops only entries whose
  // directories no longer exist -- never a branch, never a file.
  await gitIn(repoPath, 'worktree', 'prune')
  await gitIn(repoPath, 'worktree', 'add', path, input.branch)

  const timeoutMs = input.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  for (const command of input.setupCommands) {
    const outcome = await runShellCommand({ command, cwd: path, timeoutMs, env: setupEnv() })
    if (outcome.timedOut || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`setup ${commandFailure(command, timeoutMs, outcome).message}`)
    }
  }

  return { path, branch: input.branch, headCommit: await gitIn(path, 'rev-parse', 'HEAD') }
}
