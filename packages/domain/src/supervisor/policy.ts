import type { Action, Candidate, Tier } from './actions.js'
import type { SituationKind } from './situations.js'
import type { SupervisorQuestion, SupervisorSlave, SupervisorWorld } from './world.js'

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
 *   that is why `candidates` offers `raise_max_attempts` instead when they do not -- and a
 *   `reassign_question` whose target {@link mayAnswer} the question) apply immediately. Everything
 *   that raises a cap, rewrites a roster, declares work dead, puts a model's words in front of a
 *   worker, or reverses a person's own park is a proposal.
 * - `answer_question` is ALWAYS `proposed` here, and that is deliberately not the last word: the
 *   catalogue's tier is the safe default a rules-only pass would store, while the final tier of an
 *   answer decision comes from {@link answerTier} alone, once the draft exists and its sources have
 *   been checked (M39 section 5). A pass with no model wired therefore never sends an answer --
 *   there is no draft to send, and `proposed` is what says so.
 */
export function tierOf(action: Action, world: SupervisorWorld, situationKind: SituationKind): Tier {
  if (action.kind === 'escalate_to_human') return 'escalated'
  if (action.kind === 'no_action') return 'noop'
  if (world.halted !== null) return 'proposed'
  switch (action.kind) {
    case 'unblock_task':
      return situationKind === ROUTINELY_UNBLOCKABLE ? 'applied' : 'proposed'
    case 'answer_question':
      return 'proposed'
    case 'reassign_question':
      return reassignTier(action.messageId, action.toSlaveId, world)
    case 'raise_max_attempts':
    case 'set_runtime_roles':
    case 'mark_task_failed':
      return 'proposed'
  }
}

/**
 * May this slave answer this question at all? The same rule control's `reassign_not_permitted`
 * refusal enforces (M39 section 4), kept here so a decision the rules stamped `applied` cannot be
 * turned down by the verb it was stamped for.
 *
 * A role-addressed question needs a holder of THAT role -- putting it in front of somebody who does
 * not hold it is what the staffing proposals exist to fix first. A slave-addressed one has no role
 * to check, so the asker's own task supplies it: whoever could be dispatched the asking task can
 * answer a question about it. A task that is gone, or one that takes any role at all (the empty
 * `requiredRole`), leaves nothing to check and the re-address stands on the question's own terms.
 */
export function mayAnswer(question: SupervisorQuestion, slave: SupervisorSlave, world: SupervisorWorld): boolean {
  if (question.recipientRole !== null) return slave.runtimeRoles.includes(question.recipientRole)
  const task = question.taskId === null ? undefined : world.tasks.find((candidate) => candidate.id === question.taskId)
  if (task === undefined || task.requiredRole === '') return true
  return slave.runtimeRoles.includes(task.requiredRole)
}

/**
 * A re-address is routine only when it lands somewhere it can be answered. The tier is a fact about
 * the WORLD, not about the action, so the question and the target are looked up rather than
 * trusted from the stored action -- and anything the world can no longer confirm (a question that
 * has left the pending set, a slave who has left the workspace) is `proposed`, which is the tier
 * that asks a human rather than the one that acts.
 */
function reassignTier(messageId: string, toSlaveId: string, world: SupervisorWorld): Tier {
  const question = world.questions.find((pending) => pending.messageId === messageId)
  const target = world.slaves.find((slave) => slave.id === toSlaveId)
  if (question === undefined || target === undefined) return 'proposed'
  return mayAnswer(question, target, world) ? 'applied' : 'proposed'
}

/**
 * The FINAL tier of an `answer_question` decision, and the only place it is ever decided (M39
 * section 5). {@link tierOf} stamps the catalogue's `proposed` on the offer; this reads the draft
 * that came back and says what actually happens to it.
 *
 * Three rules, in this order, and the order is the point:
 * - **Critical wins over everything.** A question the lexicon flagged, or one the model itself
 *   called critical, is `escalated` whether or not its answer verified -- a perfectly sourced
 *   answer about which credential to use is exactly the answer that must not be sent automatically.
 * - **A halt holds everything back.** A guardrail has already decided this workspace should not be
 *   moving; the Supervisor may still draft, but a human sends it.
 * - **Unsourced is a proposal.** An interpretation is worth writing down and never worth sending
 *   by itself (M39 section 1).
 *
 * Only the last row -- verified, not critical, workspace running -- reaches the world by itself.
 */
export function answerTier(input: { sourced: boolean; critical: boolean; halted: boolean }): Tier {
  if (input.critical) return 'escalated'
  if (input.halted || !input.sourced) return 'proposed'
  return 'applied'
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
