import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Where worktrees live, relative to the workspace's repository root (spec §7.1). Inside the repo
 * rather than in a temp directory: a worktree is the inspection surface for a failed run (§7.4),
 * and an operator looking at why a task failed should find it next to the code, not have to be
 * told a path under `/tmp` that a reboot may already have taken away.
 */
const WORKTREE_ROOT = join('.aiteamos', 'worktrees')

/**
 * The identity every git command *the orchestrator itself* issues runs under -- layer 3 of spec
 * §7.3. Distinct from `StartRunInput.gitIdentity`, which is the *agent's* identity for the commits
 * a run produces; nothing here creates a commit, so this name is what would appear only if a git
 * subcommand unexpectedly needed an author, and it should read as the orchestrator rather than
 * impersonate whichever agent triggered the provisioning.
 *
 * Supplied per-command with `-c` rather than by writing `git config`, for the reason the M0 spike
 * found the hard way: `.git/config` is repo-wide state that worktrees do *not* isolate, so two
 * concurrent agents recovering from a missing-identity error both write it and silently overwrite
 * each other.
 */
const ORCHESTRATOR_GIT_IDENTITY = {
  name: 'AI Team OS',
  email: 'orchestrator@aiteamos.local',
} as const

export interface ProvisionWorktreeInput {
  readonly repoPath: string
  readonly baseBranch: string
  readonly taskKey: string
  readonly slug: string
  readonly setupCommands: readonly string[]
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
 * Runs git with the orchestrator's identity supplied per-command. The `-c` pairs must precede the
 * subcommand, which is why this wrapper exists rather than each call site assembling its own argv.
 */
async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-c',
      `user.name=${ORCHESTRATOR_GIT_IDENTITY.name}`,
      '-c',
      `user.email=${ORCHESTRATOR_GIT_IDENTITY.email}`,
      ...args,
    ],
    { cwd },
  )
  return stdout.trim()
}

/**
 * `execFile` rejects with an `Error` carrying the child's exit code and captured streams, but
 * types it as a plain `Error`. Narrowing here rather than casting at the throw site keeps the
 * unchecked part to one place and makes a shape that does not match degrade to "unknown exit code"
 * instead of `undefined` leaking into an operator-facing message.
 */
function describeExecFailure(cause: unknown): { readonly code: string; readonly output: string } {
  if (typeof cause !== 'object' || cause === null) return { code: 'unknown', output: '' }
  const shaped = cause as { code?: unknown; stdout?: unknown; stderr?: unknown }
  const code = typeof shaped.code === 'number' || typeof shaped.code === 'string' ? String(shaped.code) : 'unknown'
  const streams = [shaped.stderr, shaped.stdout].filter((s): s is string => typeof s === 'string' && s !== '')
  return { code, output: streams.join('\n').trim() }
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
 * Runs one setup command in the worktree, and turns a non-zero exit into a thrown error that names
 * the command, its exit code, and whatever it printed.
 *
 * The captured output is the point. Spec §7.2 exists because ADR 0001 measured a fresh worktree
 * passing `npm test` only through the accident of a zero-dependency fixture repo -- on a real
 * repository setup is what makes verify meaningful, so a setup failure is a provisioning failure,
 * and one reported as a bare exit code is one nobody can act on.
 */
async function runSetupCommand(command: string, cwd: string): Promise<void> {
  try {
    await execFileAsync('/bin/sh', ['-c', command], { cwd, env: setupEnv() })
  } catch (cause) {
    const { code, output } = describeExecFailure(cause)
    throw new Error(
      `setup command failed (exit ${code}): ${command}` + (output === '' ? '' : `\n${output}`),
      { cause },
    )
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
 */
export async function provisionWorktree(input: ProvisionWorktreeInput): Promise<WorktreeHandle> {
  const path = join(input.repoPath, WORKTREE_ROOT, input.taskKey)
  const branch = `aiteamos/${input.taskKey}-${input.slug}`

  // `worktree add -b` creates the branch and the leading directories in one step, and refuses
  // rather than clobbering if either the branch or the path already exists -- which is the
  // behaviour we want on a re-provision, since silently reusing a worktree from a previous
  // attempt would hand the agent someone else's uncommitted state.
  await git(input.repoPath, 'worktree', 'add', '-b', branch, path, input.baseBranch)

  // Sequential, and aborting on the first failure: setup commands are an ordered list whose later
  // entries routinely depend on earlier ones (`npm ci` then `npm run build`), so running on after
  // a failure produces a second, misleading error from the wrong command.
  for (const command of input.setupCommands) {
    await runSetupCommand(command, path)
  }

  const headCommit = await git(path, 'rev-parse', 'HEAD')

  return { path, branch, headCommit }
}
