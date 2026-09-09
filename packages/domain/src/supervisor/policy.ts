import type { Action, Candidate, Tier } from './actions.js'
import type { SituationKind } from './situations.js'
import type { SupervisorWorld } from './world.js'

/**
 * The one situation an `unblock_task` may be carried out ROUTINELY on (spec erratum E5).
 *
 * `blocked` has meant "a human must look at this" since M35, and two of the four entrances to it
 * are deliberate operator parks: `cancel` ("stops a run for good") and `failStartedRun`'s
 * leftover-worktree refusal, which parks `blocked` precisely so the next tick cannot adopt the
 * tree it just called wreckage. A routine unblock undid BOTH one tick later -- and since a cancel
 * costs no attempt, repeated cancels would never reach the cap either. The review cap is the one
 * park the Supervisor knows a safe exit from: the task was parked by a policy counter, not by a
 * person, and sending it back to rework is what the counter was for.
 */
const ROUTINELY_UNBLOCKABLE: SituationKind = 'review_cap_blocked'

/**
 * What would happen if this action were chosen for this SITUATION (M38 section 3, "tiers are fixed
 * in code"). Pure and total: the model never sees this function, and a workspace setting can only
 * turn the Supervisor OFF, never widen what it may do by itself.
 *
 * The situation kind is an argument, not a convenience: erratum E5 makes the tier of one action
 * (`unblock_task`) depend on WHY the task is stuck, and a tier derived from the action alone would
 * have to be either wrong for one of the two kinds or computed somewhere else -- which is exactly
 * how a stored tier and `tierOf` come to disagree about a row a human is being asked to approve.
 *
 * - `escalate_to_human` is always `escalated` and `no_action` always `noop` -- neither touches the
 *   world, so a halt cannot make either riskier than it already is.
 * - While the workspace is HALTED, every other action is `proposed`. A halt means a guardrail has
 *   already decided this workspace should not be moving; the Supervisor may still say what it
 *   would do, but a human has to be the one who does it.
 * - Otherwise: routine actions (`unblock_task` on a `review_cap_blocked` task -- attempts remain,
 *   that is why `candidates` offers `raise_max_attempts` instead when they do not -- and
 *   `nudge_answer`, which writes no state at all) apply immediately. Everything that raises a cap,
 *   rewrites a roster, declares work dead, or reverses a person's own park is a proposal.
 */
export function tierOf(action: Action, world: SupervisorWorld, situationKind: SituationKind): Tier {
  if (action.kind === 'escalate_to_human') return 'escalated'
  if (action.kind === 'no_action') return 'noop'
  if (world.halted !== null) return 'proposed'
  switch (action.kind) {
    case 'unblock_task':
      return situationKind === ROUTINELY_UNBLOCKABLE ? 'applied' : 'proposed'
    case 'nudge_answer':
      return 'applied'
    case 'raise_max_attempts':
    case 'set_runtime_roles':
    case 'mark_task_failed':
      return 'proposed'
  }
}

/**
 * The fallback decider (M38 section 5): used when no model decider is wired, when the budget is
 * exhausted, and whenever a model's answer will not parse or points outside the catalogue.
 *
 * Picks the ONE routine action if the rules offered exactly one, and escalates otherwise. Two
 * routine actions competing is precisely the case rules cannot settle -- ranking them here would
 * be the Supervisor guessing, which is what the escalation exists to avoid. `escalate_to_human` is
 * always in the list ({@link candidates} guarantees it), so this always has an answer.
 */
export function chooseByRules(cands: readonly Candidate[]): number {
  if (cands.length === 0) {
    // A caller bug, not a state the world can be in: `candidates` never returns an empty list.
    // Loud, like `renderRunContext`'s own out-of-order throw, rather than a fabricated index 0.
    throw new RangeError('chooseByRules: the candidate list is empty')
  }
  const routine = cands.flatMap((candidate, index) =>
    candidate.tier === 'applied' &&
    candidate.action.kind !== 'no_action' &&
    candidate.action.kind !== 'escalate_to_human'
      ? [index]
      : [],
  )
  if (routine.length === 1) return routine[0]!
  const escalation = cands.findIndex((candidate) => candidate.action.kind === 'escalate_to_human')
  return escalation === -1 ? cands.length - 1 : escalation
}
