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
 *   that raises a cap, rewrites a roster, declares work dead, takes planned work off the board,
 *   puts a model's words in front of a worker, or reverses a person's own park is a proposal.
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
    // ROUTINE, and the one thing that makes it different from `set_runtime_roles` is EVIDENCE
    // (M47 R4). A staffing proposal asks a human "is this the right person?"; this one asks
    // nothing -- the worker's own row already records that it provides the capability, and the
    // role being granted is the one that capability projects to by definition (R2). Nobody new
    // arrives, nothing is spent, and the union never takes a role away.
    //
    // Except onto a BUSY worker (fix round 1, Important 2). R4's first offer is the IDLE worker who
    // already provides the capability, and `staffableSlaves` has refused to offer a role change on
    // a busy one since M38 for the reason that matters here: its run is in flight and its roles
    // must not move under it. `formTeam` only SORTS idle-first, so the sole provider of a
    // capability can be busy and the offer is still made -- rightly, a human may approve it -- but
    // a tick must not apply it by itself. A worker the world does not hold is `applied` as before:
    // `applyDecision` re-reads the row and refuses `slave_not_found` if it is really gone, and
    // proposing here would park every offer made against a roster a caller had not filled.
    case 'assign_capability':
      return world.slaves.find((slave) => slave.id === action.slaveId)?.busy === true ? 'proposed' : 'applied'
    // Both bring a WORKER onto a project. Never automatic: a roster is a person's decision, and
    // a hire is a commitment the Supervisor may propose and may not make.
    case 'materialise_company_worker':
    case 'hire_from_catalog':
    // A way of working is a person's decision. There is no evidence on any row that says this
    // project should follow this process, which is exactly what makes it a proposal rather than a
    // routine apply (M48 R5).
    case 'adopt_runbook':
      return 'proposed'
    case 'raise_max_attempts':
    case 'set_runtime_roles':
    case 'mark_task_failed':
    // `cancel_task` is `proposed` on BOTH branches of the halt check above and would be even if
    // the halt short-circuit were removed (ruling R1): a cancellation is never automatic, whatever
    // the workspace is doing.
    case 'cancel_task':
    // M49 R2: a worker's own report is evidence until somebody decides it is not, and a tick that
    // withdrew five of them by itself would be the Supervisor editing the record.
    case 'discard_stale_candidates':
      return 'proposed'
  }
}

/**
 * The three facts {@link answerBar} decides on, and the whole of what the rule reads.
 *
 * Deliberately NOT a `SupervisorQuestion`: control asks the same question of a `SlaveMessage` row
 * and a `Task` row, and a shape it can build from those is what lets both sides run one rule
 * instead of two that drift (final review Important 3).
 */
export interface AnswerEligibility {
  /** Who asked. Nobody answers their own question (erratum E8). */
  readonly askerSlaveId: string
  /** The role the question was addressed to, or null when it was addressed to a slave. */
  readonly recipientRole: string | null
  /** The asking task's `requiredRole` -- null when there is no task, or the task recorded none.
   *  Read only on the slave-addressed branch; the empty string means "any role will do". */
  readonly taskRequiredRole: string | null
}

/** What stands between a worker and this question, or null when nothing does. */
export type AnswerBar = 'asker' | 'recipient_role' | 'task_role'

/**
 * THE may-answer rule, in one place (M39 section 4, final review Important 3).
 *
 * Three callers depend on it agreeing with itself: {@link tierOf} stamps a `reassign_question`
 * routine with it, `candidates.reassignTarget` only offers a target that passes it, and control's
 * `reassignQuestion` refuses `reassign_not_permitted` with it. When the domain and control each
 * spelled the rule out for themselves they disagreed about the asker -- control refused it, the
 * domain did not -- and the invariant survived only because a third filter happened to catch it.
 *
 * - **The asker, never.** It holds the asking task's role by construction, so every other clause
 *   would wave it through; a question re-addressed back to the worker that asked it is a worker
 *   asked to answer itself.
 * - **Role-addressed**: a holder of THAT role. Putting the question in front of somebody who does
 *   not hold it is what the staffing proposals exist to fix first.
 * - **Slave-addressed**: no role on the question, so the asker's own task supplies one -- whoever
 *   could be dispatched the asking task can answer a question about it. A task that is gone, or
 *   one that takes any role at all (the empty `requiredRole`), leaves nothing to check and the
 *   re-address stands on the question's own terms.
 */
export function answerBar(
  question: AnswerEligibility,
  slave: { readonly id: string; readonly runtimeRoles: readonly string[] },
): AnswerBar | null {
  if (slave.id === question.askerSlaveId) return 'asker'
  if (question.recipientRole !== null) {
    return slave.runtimeRoles.includes(question.recipientRole) ? null : 'recipient_role'
  }
  const required = question.taskRequiredRole
  if (required === null || required === '') return null
  return slave.runtimeRoles.includes(required) ? null : 'task_role'
}

/**
 * May this slave answer this question at all? {@link answerBar} read against the Supervisor's own
 * world, which is where the asking task's required role comes from.
 *
 * Kept as its own name because that is what the two domain callers want -- a boolean about a world
 * they already hold -- while control, which has rows rather than a world, calls `answerBar`
 * directly and turns its reason into the sentence an operator reads.
 */
export function mayAnswer(question: SupervisorQuestion, slave: SupervisorSlave, world: SupervisorWorld): boolean {
  const task = question.taskId === null ? undefined : world.tasks.find((candidate) => candidate.id === question.taskId)
  return (
    answerBar(
      {
        askerSlaveId: question.askerSlaveId,
        recipientRole: question.recipientRole,
        taskRequiredRole: task?.requiredRole ?? null,
      },
      slave,
    ) === null
  )
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
 *
 * The situation kind is an argument for {@link tierOf}'s reason, one situation further on: ONE kind
 * has an answer the rules already hold, and a chooser that only saw the catalogue could not tell it
 * from the ordinary case (see the branch below).
 */
export function chooseByRules(cands: readonly Candidate[], situationKind: SituationKind): number {
  if (cands.length === 0) {
    // A caller bug, not a state the world can be in: `candidates` never returns an empty list.
    // Loud, like `renderRunContext`'s own out-of-order throw, rather than a fabricated index 0.
    throw new RangeError('chooseByRules: the candidate list is empty')
  }
  // The ONE narrow exception (M48 final wave, ruling 1). Every `adopt_runbook` offer is `proposed`
  // -- a way of working is a person's decision (R5) -- so the routine scan below finds nothing here
  // and the escalation would win. That is the wrong answer three ways over: a recommendation is a
  // question the rules have ALREADY answered (`recommendRunbooks` ranked the offers and the first
  // is its best fit), an escalation about it is noise in the one place an operator reads for real
  // trouble, and the Overview's Adopt button approves a PROPOSAL -- with an escalation recorded
  // instead there is nothing for it to approve. The tier is untouched: this chooses WHICH offer is
  // written down, never whether a person still has to say yes.
  if (situationKind === 'runbook_recommended') {
    const offered = cands.findIndex((candidate) => candidate.action.kind === 'adopt_runbook')
    // Falls through when the world offered none -- a goal whose runbooks vanished between `observe`
    // and `candidates` escalates like anything else the rules cannot settle.
    if (offered !== -1) return offered
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
