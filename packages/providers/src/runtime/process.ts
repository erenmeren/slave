import type { ChildProcess } from 'node:child_process'

/**
 * How long a signalled process gets to exit on its own before it is killed outright.
 *
 * ONE value, as of M13 Series B. There were three escalations in this repo -- `packages/control`'s
 * `killWithEscalation`, `pause-signal.ts`'s `terminatePid`, and each adapter's `terminateChild` --
 * and `pause-signal.ts`'s own comment explained why it was written a third time: `packages/control`
 * DEPENDS on this package, so importing it back would be a cycle. The fix is the direction, not the
 * duplication: the primitive lives below `control`, and `control/src/kill.ts` re-exports it
 * (M13 Decision 6).
 */
export const KILL_GRACE_MS = 2_000

/** How often the grace window is re-checked, so a process that dies at once is not waited out. */
const DEATH_POLL_MS = 25

export function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else -- alive, just not ours to
    // inspect. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function signalRun(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, DEATH_POLL_MS))
  }
  return !isAlive(pid)
}

/**
 * SIGTERM, a polled grace window, then SIGKILL. Returns whether anything was signalled.
 *
 * Polled rather than sleeping the whole grace period, so the common case -- a process that exits
 * promptly on SIGTERM -- costs milliseconds instead of seconds inside an emergency stop's per-run
 * loop. A process that IGNORES SIGTERM still costs the whole window, which is what makes the
 * orchestrator's `pause_requested` interval observable (M13 Task 1).
 */
export async function killWithEscalation(pid: number | null, graceMs: number = KILL_GRACE_MS): Promise<boolean> {
  const signalled = signalRun(pid, 'SIGTERM')
  // `false` means the process is already gone (ESRCH) or there was never a pid. Nothing to
  // escalate against.
  if (!signalled || pid === null) return signalled
  if (await waitForExit(pid, graceMs)) return true
  signalRun(pid, 'SIGKILL')
  await waitForExit(pid, graceMs)
  return true
}

/**
 * The same escalation against a live `ChildProcess` this process spawned.
 *
 * A separate entry point rather than `killWithEscalation(child.pid)` because a spawner has
 * something a pid-holder does not: the `exit` event, which resolves the moment the child is reaped
 * rather than at the next poll, and `exitCode`/`signalCode`, which say the child is already gone
 * without signalling anything at all.
 */
export function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
    }, graceMs)

    child.once('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })

    child.kill('SIGTERM')
  })
}

/**
 * The environment every runtime's child is spawned with (ADR 0001, "Concurrency and the git common
 * directory").
 *
 * Identity is supplied per-process rather than by writing `git config`: two concurrent M0 agents
 * both hit the same missing-identity failure, and the one that recovered with an unscoped
 * `git config user.name/user.email` wrote into the repo-wide `.git/config`, which every worktree
 * shares. Environment variables are per-process, write no file, and cannot leak to a sibling
 * worktree's run.
 *
 * `AITEAMOS_PAUSE_FLAG` is the ONE channel either gate reads the flag path on -- the same variable
 * `scripts/pause-gate.sh` and `scripts/cursor-shell-gate.sh` read. It was measured arriving intact
 * on the Cursor side: Cursor evaluates a hook's command in a shell whose environment is its own
 * `process.env` plus Cursor's additions, so setting it on the child is sufficient and no second
 * channel is needed (M12 Task 11 §3 Q3, §8(e)). One concept, one name, whichever runtime the run
 * is on.
 *
 * `AITEAMOS_PERMISSIONS_FILE` (M18 Task 5) is the same shape of channel, for the same reason:
 * `scripts/lib/permissions.sh`'s `read_permission_verdict` is the ONE place either gate reads the
 * resolved deny list's path from. `permissionsFilePath` is required, not optional -- every start
 * and every resume writes `permissions.json` (`packages/control`'s `writePermissionsFile`) before
 * spawning, even when the resolved deny list is empty, so there is no real call site that has a
 * pause flag but no permissions file to point at.
 */
export function buildChildEnv(input: {
  readonly gitIdentity: { readonly name: string; readonly email: string }
  readonly pauseFlagPath: string
  readonly permissionsFilePath: string
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: input.gitIdentity.name,
    GIT_AUTHOR_EMAIL: input.gitIdentity.email,
    GIT_COMMITTER_NAME: input.gitIdentity.name,
    GIT_COMMITTER_EMAIL: input.gitIdentity.email,
    AITEAMOS_PAUSE_FLAG: input.pauseFlagPath,
    AITEAMOS_PERMISSIONS_FILE: input.permissionsFilePath,
  }
}
