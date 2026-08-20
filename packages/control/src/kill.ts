/**
 * Signals a run's process directly, by pid.
 *
 * The adapter cannot do this from here: its registry of live children is per-process, and a CLI
 * invocation is a *different* process from the daemon that spawned the run — so `adapter.cancel`
 * would throw "no run found" for every run there is. Task 15 carried this forward as the reason a
 * run whose process outlives its daemon had no path to being killed. The pid is in the row; that is
 * what it is for.
 */
/** How long a cancelled process gets to exit on its own before it is killed outright. */
export const KILL_GRACE_MS = 2_000

export function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
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

/** SIGTERM, a grace period, then SIGKILL if the process survived. Returns whether anything was signalled. */
export async function killWithEscalation(pid: number | null, graceMs: number = KILL_GRACE_MS): Promise<boolean> {
  const signalled = signalRun(pid, 'SIGTERM')
  if (signalled) {
    await new Promise((res) => setTimeout(res, graceMs))
    if (isAlive(pid)) signalRun(pid, 'SIGKILL')
  }
  return signalled
}
