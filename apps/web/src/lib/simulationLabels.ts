import type { SimulationSummary } from '@slave-of-ai/control'

/**
 * R5 leak 6: the sim list painted a `Chip` with the raw `SimulationStatus` value. Same five
 * states, said out loud. `ready` is the one that is not a restatement of its key: a run that has
 * not been stepped yet is not "ready for you to read", it simply has not started.
 *
 * `Record<SimulationSummary['status'], string>` is load-bearing the same way the domain's own
 * label tables are: a sixth status fails the build here rather than rendering as `undefined`.
 * The type is imported TYPE-ONLY from `@slave-of-ai/control`, the same way `SimulationsClient`
 * itself does it, so nothing from control's runtime reaches the client bundle.
 */
export const SIMULATION_STATUS_LABEL: Record<SimulationSummary['status'], string> = {
  ready: 'Not started',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  halted: 'Halted',
}
