import { z } from 'zod'

/**
 * Every action the Supervisor may choose (M38 §3). Closed, and rule-built: the model picks an
 * INDEX into a list the rules produced, so it can never name an action that is not here (spec §1,
 * "model output never writes"). Each maps to exactly one existing control verb in Task 2 --
 * nothing here spawns a run, edits a repository or writes a prompt.
 */
export type Action =
  /** `unblockTask`: a `blocked` task back to `rework` on the attempts it still has. */
  | { readonly kind: 'unblock_task'; readonly taskId: string }
  /** `unblockTask` with `allowAnotherAttempt`: the same, but the cap has to move first. */
  | { readonly kind: 'raise_max_attempts'; readonly taskId: string }
  /** `setRuntimeRoles`: the slave's current set PLUS the missing role -- never a replacement, and
   *  applied as a union. The array stored here is what the rules computed at DECISION time; a
   *  proposal can wait a day, so `applyDecision` re-reads the slave and writes the union of its
   *  current set with these, which is what stops an approval taking back a role granted meanwhile. */
  | { readonly kind: 'set_runtime_roles'; readonly slaveId: string; readonly roles: readonly string[] }
  /** `answerQuestion` with `answeredBy: 'supervisor'`: the Supervisor answers a slave's question
   *  itself, in a body a SECOND model call drafted and `verifySources` checked. This is the one
   *  action whose stored tier is not the last word: the catalogue stamps it `proposed` and
   *  {@link answerTier} decides the final tier from the draft (M39 section 5). */
  | { readonly kind: 'answer_question'; readonly messageId: string }
  /** `reassignQuestion`: the same question, put in front of a slave who can actually answer it --
   *  no new message, no model text, just a re-addressed row. */
  | { readonly kind: 'reassign_question'; readonly messageId: string; readonly toSlaveId: string }
  /** `failTask`: a dead end declared dead, so dependents stop waiting on it. */
  | { readonly kind: 'mark_task_failed'; readonly taskId: string; readonly reason: string }
  /** `cancelTask`: work the changed goal no longer needs, taken off the board (M40 §4). ALWAYS a
   *  proposal ({@link tierOf}, ruling R1) -- the model asked for it inside a re-plan delta, and a
   *  wrong deletion costs real planned work while a wrong addition costs one backlog row. */
  | { readonly kind: 'cancel_task'; readonly taskId: string; readonly reason: string }
  /** No verb at all -- a row a human is asked to look at. The always-available last resort. */
  | { readonly kind: 'escalate_to_human'; readonly summary: string }
  /** Deliberately nothing: the situation is real but waiting is the right move. */
  | { readonly kind: 'no_action' }

/** Every {@link Action} kind as data -- what the `supervisor.*` event payloads validate against. */
export const ACTION_KINDS = [
  'unblock_task',
  'raise_max_attempts',
  'set_runtime_roles',
  'answer_question',
  'reassign_question',
  'mark_task_failed',
  'cancel_task',
  'escalate_to_human',
  'no_action',
] as const

/** The NAME of an action, as a stored decision row carries it -- what a reader (the mailbox
 *  counts, the panel's filters) needs when it wants to know WHAT was decided without parsing the
 *  whole action back out of its `Json` column. */
export type ActionKind = (typeof ACTION_KINDS)[number]

/** Validates a `SupervisorDecision.action` `Json` value at read. */
export const actionSchema: z.ZodType<Action> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unblock_task'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('raise_max_attempts'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('set_runtime_roles'), slaveId: z.string().min(1), roles: z.array(z.string().min(1)) }),
  z.object({ kind: z.literal('answer_question'), messageId: z.string().min(1) }),
  z.object({
    kind: z.literal('reassign_question'),
    messageId: z.string().min(1),
    toSlaveId: z.string().min(1),
  }),
  z.object({ kind: z.literal('mark_task_failed'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('cancel_task'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('escalate_to_human'), summary: z.string().min(1) }),
  z.object({ kind: z.literal('no_action') }),
])

/**
 * What happens to a chosen action (spec §1, "tiers are fixed in code, not chosen by the model"):
 * `applied` runs now through a control verb, `proposed` and `escalated` become a `pending` row a
 * human approves or rejects, `noop` is recorded and does nothing. Decided by {@link tierOf}, never
 * by the model and never by a workspace setting -- a workspace can only turn the Supervisor OFF.
 */
export const TIERS = ['applied', 'proposed', 'escalated', 'noop'] as const
export type Tier = (typeof TIERS)[number]

/** One offer in the catalogue the rules build for a situation: what could be done, what would
 *  happen if it were chosen, and the one sentence a human (or the model) judges it by. */
export interface Candidate {
  readonly action: Action
  readonly tier: Tier
  readonly why: string
}

export const candidateSchema: z.ZodType<Candidate> = z.object({
  action: actionSchema,
  tier: z.enum(TIERS),
  why: z.string().min(1),
})

/**
 * The life of a `SupervisorDecision` row (spec §2). `applied` and `failed` are terminal at birth
 * or at apply time; `pending` is the only OPEN state, and it leaves through `approved`,
 * `rejected` or `expired`.
 */
export const DECISION_STATUSES = ['applied', 'pending', 'approved', 'rejected', 'expired', 'failed'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** Who picked the candidate: the model, or {@link chooseByRules} (no decider wired, no budget
 *  left, or an answer that would not parse). Recorded on every row so a reader can tell the two
 *  apart without inspecting the rationale. */
export const DECIDERS = ['model', 'rules'] as const
export type Decider = (typeof DECIDERS)[number]
