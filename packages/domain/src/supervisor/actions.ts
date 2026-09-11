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
  /** `setRuntimeRoles` (as a union): a worker who ALREADY provides the capability is given the
   *  runtime role it projects to. The routine one of the three (M47 R4) -- see `tierOf`.
   *
   *  `capabilityLabel` is the taxonomy's WORDS for {@link capability}, carried on the action rather
   *  than resolved by whoever renders it (M47 final review, Minor 5b): `actionText` runs in the
   *  browser, where there is no taxonomy, and a decision row read a year from now must still say
   *  what it was about in the vocabulary of the day it was made. The key stays for the machines. */
  | { readonly kind: 'assign_capability'; readonly slaveId: string; readonly capability: string; readonly capabilityLabel: string; readonly role: string }
  /** `materialiseCompanySlave`: one worker off the company roster onto this project. `rationale`
   *  is the sentence stored on the worker (`Slave.selectionRationale`), exactly as it is for a
   *  catalog hire -- what the Organization view shows a person months later, in words rather than
   *  in taxonomy keys (fix round 1, Minor 5). */
  | { readonly kind: 'materialise_company_worker'; readonly companySlaveId: string; readonly capability: string; readonly capabilityLabel: string; readonly name: string; readonly rationale: string }
  /** `hireFromTemplate`: a new project worker from a catalog template. `rationale` is the sentence
   *  stored on the worker (`Slave.selectionRationale`) and shown on the Organization view --
   *  "why selected", months later. `temporary` is M50's lifecycle, recorded as a claim on the
   *  decision and in the rationale until there is something that can release a worker. */
  | { readonly kind: 'hire_from_catalog'; readonly templateId: string; readonly capability: string; readonly capabilityLabel: string; readonly name: string; readonly rationale: string; readonly temporary: boolean }
  /** `adoptRunbook`: the workspace adopts a way of working. Never automatic ({@link tierOf}) -- a
   *  process is a person's decision, exactly as a hire is, and the next plan is written against it.
   *  `name` and `rationale` are carried on the action rather than resolved by whoever renders it,
   *  for `assign_capability`'s own reason: a panel has no runbook table, and a row read a year
   *  later must still say what it was about. */
  | { readonly kind: 'adopt_runbook'; readonly runbookId: string; readonly key: string; readonly name: string; readonly rationale: string }
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
  /** `discardStaleCandidates`: the OBSERVATION candidates nothing ever verified, marked `removed`
   *  with a reason. NEVER a deletion (R1) and never automatic ({@link tierOf}): withdrawing a
   *  worker's own report is a judgement, and the rows stay in the table either way. */
  | { readonly kind: 'discard_stale_candidates'; readonly workspaceId: string; readonly count: number }
  /** No verb at all -- a row a human is asked to look at. The always-available last resort. */
  | { readonly kind: 'escalate_to_human'; readonly summary: string }
  /** Deliberately nothing: the situation is real but waiting is the right move. */
  | { readonly kind: 'no_action' }

/** Every {@link Action} kind as data -- what the `supervisor.*` event payloads validate against. */
export const ACTION_KINDS = [
  'unblock_task',
  'raise_max_attempts',
  'set_runtime_roles',
  'assign_capability',
  'materialise_company_worker',
  'hire_from_catalog',
  'adopt_runbook',
  'answer_question',
  'reassign_question',
  'mark_task_failed',
  'cancel_task',
  'discard_stale_candidates',
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
  z.object({
    kind: z.literal('assign_capability'),
    slaveId: z.string().min(1),
    capability: z.string().min(1),
    capabilityLabel: z.string().min(1),
    role: z.string().min(1),
  }),
  z.object({
    kind: z.literal('materialise_company_worker'),
    companySlaveId: z.string().min(1),
    capability: z.string().min(1),
    capabilityLabel: z.string().min(1),
    name: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.object({
    kind: z.literal('hire_from_catalog'),
    templateId: z.string().min(1),
    capability: z.string().min(1),
    capabilityLabel: z.string().min(1),
    name: z.string().min(1),
    rationale: z.string().min(1),
    temporary: z.boolean(),
  }),
  z.object({
    kind: z.literal('adopt_runbook'),
    runbookId: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.object({ kind: z.literal('answer_question'), messageId: z.string().min(1) }),
  z.object({
    kind: z.literal('reassign_question'),
    messageId: z.string().min(1),
    toSlaveId: z.string().min(1),
  }),
  z.object({ kind: z.literal('mark_task_failed'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('cancel_task'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({
    kind: z.literal('discard_stale_candidates'),
    workspaceId: z.string().min(1),
    count: z.number().int().positive(),
  }),
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

/** What a tier means to a person (M44 R5): what actually happened to the chosen action. */
export const TIER_LABEL: Record<Tier, string> = {
  applied: 'Done',
  proposed: 'Waiting for you',
  escalated: 'Escalated to you',
  noop: 'Nothing to do',
}

/** A decision's life, in words. `pending` is the only OPEN state, and it is the one that says so. */
export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  applied: 'Applied',
  pending: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Failed',
}

/** Who picked the candidate. */
export const DECIDER_LABEL: Record<Decider, string> = {
  model: 'the model',
  rules: 'the rules',
}
