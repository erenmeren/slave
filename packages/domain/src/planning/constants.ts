/**
 * How many planning runs may fail against the current goal before dispatch stops trying (M12 spec
 * Decision 8).
 *
 * HERE RATHER THAN IN THE ORCHESTRATOR, which is where it was declared until H4a (2026-09-21).
 * Two things in two packages now count to this number and they must be the same number:
 * `dispatchPlanning` stops dispatching at it, and the Supervisor's `observe` raises
 * `planning_stalled { reason: 'cap_spent' }` the moment the world reaches it. A second copy would
 * let the tick give up at two while the Supervisor waited for three -- which is exactly the state
 * this hotfix exists to end: a project that has gone quiet with nothing on any report to say why.
 * `apps/orchestrator/src/planning.ts` re-exports this one so every existing importer (the CLI's
 * `replan-status`, `replanIntent`) keeps its path.
 *
 * Two, and the two are different attempts at different things: the first plan is the model's read
 * of the goal, and the second is its read of the goal after the first one did not parse or did not
 * finish. A third would be the same ask a third time -- at which point the cap is the finding, and
 * `planning_stalled` is where a person (or the Supervisor's own `retry_planning`) meets it.
 */
export const PLANNING_RETRY_CAP = 2
