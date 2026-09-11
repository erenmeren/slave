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
  /**
   * M48 R5: a goal exists, the board is empty and no way of working has been chosen -- the one
   * moment at which adopting a runbook changes what the next run is asked for. `subjectId` is the
   * WORKSPACE id, so a project has one of these rather than one per candidate runbook.
   *
   * Directly after `no_planner` (plan decision D3) because that is how the pair reads: "nobody can
   * plan it", and then "and here is how it could be planned". It fires only when
   * `recommendRunbooks` has an opinion -- no keyword hit anywhere, no situation at all.
   */
  'runbook_recommended',
  'review_cap_blocked',
  'task_failed',
  'task_blocked_human',
  /**
   * M40 §3: a task the CHANGED goal no longer needs. `subjectId` is the task id; facts are
   * `{ goalVersion, currentVersion, reason: 'replan_cancel' }`.
   *
   * THE ONE KIND {@link observe} NEVER EMITS, and the exception is the point: every other
   * situation is a predicate over the world, re-derivable on any tick from rows alone. This one is
   * a JUDGEMENT the manager's own re-plan run made -- "the new goal does not need this task" is
   * not readable off a `Task` row, and a rule that guessed it from `goalVersion < currentVersion`
   * would propose cancelling every task on the board the moment a goal was edited. It is recorded
   * directly by the orchestrator's `concludeReplan` (spec §5), which has the delta in hand.
   */
  'stale_task',
  'waiting_stale',
  'unanswerable_question',
  /**
   * M47 R4: a startable task needs a CAPABILITY nobody in this workspace can be dispatched for.
   * `subjectId` is the capability key, so ten tasks blocked on one gap are one situation.
   *
   * Supersedes {@link ready_unstaffed} for the task that raised it (plan erratum E8) -- that kind
   * remains the role-only fallback, for a task that declared no capabilities at all and for one
   * whose capabilities are staffed but whose hand-typed role is held by nobody.
   *
   * Declared in M47 Task 1, with the Postgres enum member its migration adds: `enum-parity.test.ts`
   * asserts the two are the same list, member for member, precisely so a column and a union cannot
   * drift apart across tasks. Nothing PRODUCES it until Task 3 -- `observe` has no predicate for it
   * and `candidates` no arm, which is the ordinary "declared before it is emitted" state the parity
   * test forces.
   */
  'capability_unstaffed',
  'ready_unstaffed',
  'done_not_integrated_stale',
  /**
   * M50 R3: a worker brought in for ONE assignment, whose assignment is over. `subjectId` is the
   * SLAVE id -- this is about a person's engagement, not about a task or a role, and it is the
   * first situation in this list whose subject is a worker.
   *
   * Directly after `done_not_integrated_stale` and before `memory_candidates_piling` (plan decision
   * D1): all three are housekeeping. Nothing is stuck, nothing is waiting on a person, and a reader
   * meets "finished, not integrated", "this engagement is over" and "nothing verified what was
   * reported" in one pass at the foot of the report.
   */
  'engagement_over',
  /**
   * M49 R2: unverified OBSERVATION candidates are piling up -- five or more older than
   * {@link MEMORY_CANDIDATE_STALE_MS}. `subjectId` is the WORKSPACE id: this is about the project's
   * knowledge, not about any one row in it.
   *
   * Last of the project-wide situations and directly before `workspace_halted`, because it is the
   * least urgent thing on this list that is still worth a person's attention: nothing is stuck, and
   * nothing a worker claimed has become knowledge.
   */
  'memory_candidates_piling',
  'workspace_halted',
] as const

export type SituationKind = (typeof SITUATION_KINDS)[number]

/**
 * One thing that is stuck, as the rules saw it.
 *
 * `subjectId` is the second half of the situation KEY `(workspaceId, kind, subjectId)` (spec §2):
 * the task id for the task situations (`stale_task` included), the message id for the question
 * situations, the ROLE NAME
 * for `no_reviewer`/`no_planner`/`ready_unstaffed` (so ten ready tasks missing one role are one
 * situation, not ten), the CAPABILITY KEY for `capability_unstaffed` (M47 R4, same rule one level
 * more specific), the WORKSPACE id for `runbook_recommended` -- which is about the project rather
 * than about any row in it -- and the workspace id for `workspace_halted`.
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

/**
 * What each situation is called when a person reads it (M44 R5). `SITUATION_KINDS` are keys, and a
 * key rendered as prose is the leak M44 closes -- the Supervisor panel's recent-decision rows read
 * `no_reviewer · proposed · pending · by model`.
 *
 * `Record<SituationKind, string>` is load-bearing: a SIXTEENTH kind fails the build here rather
 * than turning up on the page as an identifier (fifteen as of M50's `engagement_over`).
 * Each label says what is STUCK, in the words the report already uses; the decision's own
 * `situation.summary` carries the specifics beside it.
 */
export const SITUATION_LABEL: Record<SituationKind, string> = {
  no_reviewer: 'No reviewer',
  no_planner: 'No planner',
  runbook_recommended: 'A way of working to adopt',
  review_cap_blocked: 'Review attempts used up',
  task_failed: 'Task failed',
  task_blocked_human: 'Blocked, needs a person',
  stale_task: 'Work the goal no longer needs',
  waiting_stale: 'Waiting too long',
  unanswerable_question: 'Question nobody can answer',
  capability_unstaffed: 'Missing a capability',
  ready_unstaffed: 'Ready work, nobody to do it',
  done_not_integrated_stale: 'Finished, not integrated',
  engagement_over: 'Engagement over',
  memory_candidates_piling: 'Unverified knowledge piling up',
  workspace_halted: 'Project halted',
}
