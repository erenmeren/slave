import { writeFile } from 'node:fs/promises'
import { capabilitiesOf } from './capabilities.js'
import { killWithEscalation } from './runtime/process.js'
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
 * What the signal actually IS remains the provider's own knowledge, which is why this lives here
 * rather than in `packages/control`: Claude denies the run's next tool call through its hook, by
 * reading the flag this writes back (`scripts/pause-gate.sh`); a runtime with no mid-run gate stops
 * some other way entirely, using `pid` instead of a flag file, without `packages/control` ever
 * having to know the difference.
 *
 * **The strategy is chosen by `canPauseMidRun`, not by the kind** (spec §4, "pause dispatches on
 * capability"; final review I1). This used to be a `switch (kind)` with one case per vendor, which
 * made the capability table a claim nothing checked: a provider could declare `canPauseMidRun:
 * true` and be killed anyway, and nothing would fail. Reading the boolean is what makes the
 * declaration load-bearing -- the two are now the same fact, asserted by
 * `pause-signal-capability.test.ts` over every member of `PROVIDER_KINDS`.
 *
 * The `never` exhaustiveness guard that used to live in this switch is not lost, it moved down one
 * level: `capabilitiesOf` carries it (`capabilities.ts`), so a third `ProviderKind` with no
 * capability row is still a BUILD failure naming the unhandled member, and one WITH a row gets the
 * strategy its row declares rather than falling out of a switch nobody remembered to widen.
 */
export async function signalPause(kind: ProviderKind, state: PausableRunState, reason: string): Promise<void> {
  return capabilitiesOf(kind).canPauseMidRun
    ? signalGatedPause(state, reason)
    : signalTerminatingPause(kind, state, reason)
}

/**
 * The strategy for a runtime that CAN stop between tool calls (`canPauseMidRun: true`): write
 * `reason` into the run's pause flag file and let the runtime's own gate deny the next call.
 *
 * Byte for byte identical to what `packages/control/src/pause.ts` wrote directly before this
 * function existed -- `scripts/pause-gate.sh` reads it back the same way. Only `pauseFlagPath` is
 * used; `pid` is part of `PausableRunState` for the other strategy, not because this one needs it.
 */
async function signalGatedPause(state: PausableRunState, reason: string): Promise<void> {
  await writeFile(state.pauseFlagPath, `${reason}\n`, 'utf8')
}

/**
 * The strategy for a runtime that CANNOT stop between tool calls (`canPauseMidRun: false`): end
 * the process, which for such a runtime is what a pause is. Cursor is the only member today;
 * `kind` is a parameter rather than a constant so the refusal below names whichever runtime
 * actually declared the capability, not a vendor this branch happened to be written for.
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
 * it would leave the run's last act ungated for the whole of `killWithEscalation`'s grace window
 * (`runtime/process.ts`, the one escalation in the tree as of M13 Decision 6 -- this file used to
 * carry a third copy, because `packages/control`'s was unreachable from here without a cycle; the
 * primitive moved BELOW `control` instead). It is also the
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
async function signalTerminatingPause(
  kind: ProviderKind,
  state: PausableRunState,
  reason: string,
): Promise<void> {
  // The pid is checked BEFORE anything is written, and the order was chosen by a failing test
  // rather than by taste: with the flag write first, a filesystem error on the flag path (the
  // existing `pause-signal.test.ts` case hits a real `EISDIR`) surfaced instead of the pid
  // diagnosis, hiding the more actionable of the two failures behind the less. Validating the
  // arguments before performing a side effect is also simply the right way round.
  if (state.pid === null) {
    throw new Error(
      `signalPause: cannot pause a ${kind} run with no recorded pid. ${kind} has no mid-run gate ` +
        '(canPauseMidRun: false), so ending the process IS the pause -- with no pid there is ' +
        'nothing to signal, and reporting success here would claim a pause that never happened.',
    )
  }

  // Then the flag, before the signal, so the gate is armed for whatever the child manages to start
  // in the window between this call and its death. Nothing is skipped by the ordering above: with
  // no pid there is no live process for the gate to deny anything to.
  await writeFile(state.pauseFlagPath, `${reason}\n`, 'utf8')
  await killWithEscalation(state.pid)
}
