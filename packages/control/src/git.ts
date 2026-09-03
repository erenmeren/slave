import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
 *
 * Moved here from `apps/orchestrator/src/worktree.ts` in M23 B2: `collectTaskWorktree` needs the
 * same identity-scoped `git worktree remove`/`prune` this module already runs every other git
 * subcommand through, and `packages/control` cannot import from `apps/orchestrator` -- the
 * dependency only ever runs the other way.
 */
export const ORCHESTRATOR_GIT_IDENTITY = {
  name: 'AI Team OS',
  email: 'orchestrator@aiteamos.local',
} as const

/**
 * Runs git with the orchestrator's identity supplied per-command. The `-c` pairs must precede the
 * subcommand, which is why this wrapper exists rather than each call site assembling its own argv.
 *
 * Exported as `gitIn` for Task 5's review dispatch, which needs the identical identity-scoped `git
 * diff` this module already runs every other git subcommand through -- a second wrapper would be a
 * second place the `-c user.name=…`/`-c user.email=…` pair could drift from this one.
 */
export async function gitIn(cwd: string, ...args: readonly string[]): Promise<string> {
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
