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
      // M12 Series D lands Cursor's adapter; its pause signal (cancellation, not a mid-run gate
      // -- `progress.md`'s 4→12 ruling) is that task's to write, not this one's to guess at.
      throw new Error('signalPause: provider kind "cursor" has no pause signal implemented yet')
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
