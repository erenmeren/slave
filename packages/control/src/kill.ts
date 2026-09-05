/**
 * Signalling a run's process directly, by pid.
 *
 * The adapter cannot do this from here: its registry of live children is per-process, and a CLI
 * invocation is a *different* process from the daemon that spawned the run — so `adapter.cancel`
 * would throw "no run found" for every run there is. Task 15 carried this forward as the reason a
 * run whose process outlives its daemon had no path to being killed. The pid is in the row; that is
 * what it is for.
 *
 * The IMPLEMENTATION moved down to `packages/providers/src/runtime/process.ts` in M13 (Decision 6):
 * `packages/control` depends on `packages/providers`, so a vendor-neutral primitive both packages
 * need can only live in the lower one. This file stays so its importers do not move — `pump.ts`,
 * `sweep.ts`, the gate scripts and `emergency.ts` all reach these through `@slave-of-ai/control`.
 */
export { KILL_GRACE_MS, isAlive, killWithEscalation, signalRun } from '@slave-of-ai/providers'
