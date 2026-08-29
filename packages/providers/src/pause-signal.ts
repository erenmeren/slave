import { writeFile } from 'node:fs/promises'
import type { ProviderKind } from './types.js'

/**
 * The persisted facts any process needs in order to signal a pause. Both columns already exist
 * on `AgentRun` (`Checkpoint.pauseFlagPath` / `AgentRun.pid`) -- nothing new is stored for this.
 */
export interface PausableRunState {
  readonly pauseFlagPath: string
  readonly pid: number | null
}

/**
 * Signal a pause from ANY process, given only what the run's row persists.
 *
 * Pausing is a cross-process control signal (spec §11): the caller here is usually not the
 * process that spawned the run's child and holds its live `AgentRuntimeAdapter` state -- an
 * operator's CLI invocation, or a web request, are both new processes with no such state, and no
 * adapter-instance method could ever serve them (M12 Task 4 retired the one that tried,
 * `AgentRuntimeAdapter.requestPause`, for exactly this reason). So this function deliberately
 * takes no adapter instance, no constructor options, and touches no in-memory run registry --
 * only `kind` and the two columns already on the row.
 *
 * What the signal actually IS remains the provider's own knowledge, which is why this dispatches
 * on `kind` rather than living in `packages/control`: Claude denies the run's next tool call
 * through its hook, by reading the flag this writes back (`scripts/pause-gate.sh`); a runtime
 * with no mid-run gate (`ProviderCapabilities.canPauseMidRun === false`) would stop some other
 * way entirely, using `pid` instead of a flag file, without `packages/control` ever having to
 * know the difference.
 */
export async function signalPause(kind: ProviderKind, state: PausableRunState, reason: string): Promise<void> {
  switch (kind) {
    case 'claude_code':
      return signalClaudeCodePause(state, reason)
    case 'cursor':
      return signalCursorPause(state, reason)
    default: {
      // The Task 3 -> Task 8 ruling, discharged here: this switch was exhaustive only by
      // INSPECTION. `tsconfig.base` sets `strict` but not `noImplicitReturns`, so adding a third
      // `ProviderKind` would have fallen out of the switch and returned `undefined` -- a provider
      // that silently no-ops its own pause, which is a hole in the strongest guarantee this system
      // makes. Binding `kind` to `never` makes that a BUILD failure naming the unhandled member.
      // This grew teeth at Task 8's fix round: `kind` used to arrive as a compile-time constant
      // and now arrives as a run's own DB column, so inspection no longer sees every caller.
      const unhandled: never = kind
      throw new Error(`signalPause: unhandled provider kind ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * Writes `reason` into the run's pause flag file, byte for byte identical to what
 * `packages/control/src/pause.ts` wrote directly before this function existed --
 * `scripts/pause-gate.sh` reads it back the same way. Only `pauseFlagPath` is used; `pid` is part
 * of `PausableRunState` for a provider that needs it (none does yet), not because this one does.
 */
async function signalClaudeCodePause(state: PausableRunState, reason: string): Promise<void> {
  await writeFile(state.pauseFlagPath, `${reason}\n`, 'utf8')
}

/** How long a signalled process gets to exit on its own before it is killed outright. */
const CURSOR_KILL_GRACE_MS = 2_000

/** How often the grace window is re-checked, so a process that dies at once is not waited out. */
const DEATH_POLL_MS = 25

/**
 * Pauses a Cursor run by ENDING ITS PROCESS, which for this runtime is what a pause is.
 *
 * `ProviderCapabilities.canPauseMidRun` is `false` for Cursor: there is no mechanism that stops the
 * agent between tool calls and leaves it resumable in place, so the pause protocol is cancel now
 * and `--resume <sessionId>` later (progress.md's 4→12 ruling, and the M12 plan's own Task 12 text:
 * "cancels the process and lets `pump.ts` write the checkpoint carrying `sessionId` and
 * `provider`"). The `sessionId` that makes that resume possible is already on the run's row, and
 * the pump writes the checkpoint when the stream ends -- which is what killing the process causes.
 *
 * **The pause flag is written as well, and deliberately.** It is not redundant with the kill: the
 * two are a sequence, not alternatives. Between the moment this function signals and the moment the
 * child actually dies, the agent can still start a shell command or a file write, and
 * `scripts/cursor-shell-gate.sh` -- armed from this very file by `.cursor/hooks.json` -- is the only
 * thing that can stop it. Writing the flag first costs one `write` and closes that window; skipping
 * it would leave the run's last act ungated for the whole of the grace period below. It is also the
 * same file, in the same format, that the Claude branch writes: one concept, one path per run,
 * whichever runtime the run is on.
 *
 * **A `null` pid throws.** The Claude branch can honestly write a flag and return, because its gate
 * denies the next tool call whenever the child reaches one. Cursor has no such mechanism, so with
 * no pid there is no way to stop the run at all -- and returning normally would report a pause that
 * did not happen. `pauseActiveRuns` turns that throw into a `refused` entry rather than a silent
 * success, which is the whole reason its per-run `try/catch` exists.
 *
 * A pid that has ALREADY exited is not an error: losing that race is the ordinary case a guardrail
 * fan-out runs into, exactly as `requestPause`'s own status race is.
 */
async function signalCursorPause(state: PausableRunState, reason: string): Promise<void> {
  // The pid is checked BEFORE anything is written, and the order was chosen by a failing test
  // rather than by taste: with the flag write first, a filesystem error on the flag path (the
  // existing `pause-signal.test.ts` case hits a real `EISDIR`) surfaced instead of the pid
  // diagnosis, hiding the more actionable of the two failures behind the less. Validating the
  // arguments before performing a side effect is also simply the right way round.
  if (state.pid === null) {
    throw new Error(
      'signalPause: cannot pause a cursor run with no recorded pid. Cursor has no mid-run gate ' +
        '(canPauseMidRun: false), so ending the process IS the pause -- with no pid there is ' +
        'nothing to signal, and reporting success here would claim a pause that never happened.',
    )
  }

  // Then the flag, before the signal, so the gate is armed for whatever the child manages to start
  // in the window between this call and its death. Nothing is skipped by the ordering above: with
  // no pid there is no live process for the gate to deny anything to.
  await writeFile(state.pauseFlagPath, `${reason}\n`, 'utf8')
  await terminatePid(state.pid)
}

/**
 * SIGTERM, a polled grace window, then SIGKILL. The same discipline as `packages/control`'s
 * `killWithEscalation` and the Cursor adapter's own `terminateChild`, written here a third time
 * because neither is reachable: `packages/control` DEPENDS on this package (importing it back
 * would be a cycle), and the adapter's version acts on a live `ChildProcess` this process spawned,
 * which is precisely what a cross-process pause does not have. Polled rather than sleeping the
 * whole grace period, so the common case -- a process that exits promptly on SIGTERM -- costs
 * milliseconds instead of seconds inside an emergency stop's per-run loop.
 */
async function terminatePid(pid: number): Promise<void> {
  // `false` means the process is already gone (ESRCH). Nothing to escalate against.
  if (!sendSignal(pid, 'SIGTERM')) return
  if (await waitForExit(pid, CURSOR_KILL_GRACE_MS)) return
  sendSignal(pid, 'SIGKILL')
  await waitForExit(pid, CURSOR_KILL_GRACE_MS)
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else -- alive, just not ours to
    // inspect. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
