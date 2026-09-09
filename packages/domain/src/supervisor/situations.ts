import { z } from 'zod'

/**
 * Every stuck situation the Supervisor knows how to see (M38 §3), in the order `observe` reports
 * them -- roughly "who is missing" before "what is stuck" before "the whole workspace is down",
 * which is the order an operator reads a report in. The order is part of the contract:
 * {@link observe} sorts by this list's index, so two runs over the same world produce byte-equal
 * output.
 *
 * The list is closed. A situation the rules cannot name is not a Supervisor situation -- it stays
 * a `guardrail.tripped` for a human, which is what M38 §8 keeps out of scope.
 */
export const SITUATION_KINDS = [
  'no_reviewer',
  'no_planner',
  'review_cap_blocked',
  'task_failed',
  'task_blocked_human',
  'waiting_stale',
  'unanswerable_question',
  'ready_unstaffed',
  'done_not_integrated_stale',
  'workspace_halted',
] as const

export type SituationKind = (typeof SITUATION_KINDS)[number]

/**
 * One thing that is stuck, as the rules saw it.
 *
 * `subjectId` is the second half of the situation KEY `(workspaceId, kind, subjectId)` (spec §2):
 * the task id for the task situations, the message id for the question situations, the ROLE NAME
 * for `no_reviewer`/`no_planner`/`ready_unstaffed` (so ten ready tasks missing one role are one
 * situation, not ten), and the workspace id for `workspace_halted`.
 *
 * `summary` is for a human and for the model prompt; `facts` is the evidence the predicate fired
 * on, kept as flat scalars so the whole thing survives a round trip through `SupervisorDecision.
 * situation` (a `Json` column) and can be read back months later without re-deriving anything.
 */
export interface Situation {
  readonly kind: SituationKind
  readonly subjectId: string
  readonly summary: string
  readonly facts: Readonly<Record<string, string | number | boolean | null>>
}

/** Validates a `SupervisorDecision.situation` `Json` value at read, the way
 *  `runContextManifestSchema` (M37) validates a stored manifest -- a hand-edited or
 *  pre-migration row must not crash the web panel or the CLI that reads it back. */
export const situationSchema: z.ZodType<Situation> = z.object({
  kind: z.enum(SITUATION_KINDS),
  subjectId: z.string().min(1),
  summary: z.string().min(1),
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
