import type { DomainEventType } from '@slave-of-ai/db'
import { feedSummary } from './feedSummary'

export interface HappeningNames {
  readonly actor: string | null
  readonly taskTitle: string | null
}

const quoted = (n: HappeningNames): string => (n.taskTitle === null ? 'a task' : `"${n.taskTitle}"`)
const who = (n: HappeningNames): string => n.actor ?? 'Somebody'
const str = (p: Record<string, unknown>, k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null)

/**
 * The families Home's feed and the Activity digest draw from (spec R10/R11).
 *
 * The plan draft named a few types no `DomainEventType` (`packages/db/src/enums.ts`) actually has
 * -- `task.assigned`, `task.completed`, `task.verified`, `task.blocked`, `run.completed`,
 * `merge.queued`, `merge.merged`, `review.approved`, `review.rejected` -- and this list carries
 * their real replacements instead (task-2-report.md says which is which):
 *
 *  - `task.assigned` → `task.started`: the orchestrator claims `ready`/`rework` straight to
 *    `running` (`tick.ts`) and fires `task.started` at that moment, so it is the event that means
 *    "a slave picked this up", not a separate `assigned` row that is never written.
 *  - `task.completed` → `task.done`, `task.verified` → `task.verify_passed`: the real past-tense
 *    names for the same two moments.
 *  - `task.blocked` → `guardrail.tripped`: there is no domain event for ENTERING `blocked` (only
 *    `task.unblocked` for leaving it) -- every park to `blocked` in the orchestrator
 *    (`review.ts`, `verify.ts`, `tick.ts`, `sweep.ts`, `planning.ts`) writes `guardrail.tripped`
 *    beside the status write, so that is the real event an operator's feed sees.
 *  - `run.completed` → `run.succeeded`: the real name.
 *  - `merge.merged` → `task.integrated`: merging a `done` task's branch stamps `integratedAt` and
 *    fires `task.integrated` (`merge.ts`); there is no separate `merge.*` namespace.
 *  - `merge.queued` → dropped: nothing marks the moment between review-approved and merge-attempted
 *    with its own event, and `task.review_approved` (below) already covers "about to merge".
 *  - `review.approved` → `task.review_approved`, `review.rejected` → `task.review_rejected`: the
 *    real names -- reviews are a `task.*` event, not their own `review.*` namespace.
 */
export const HAPPENING_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set', 'supervisor.proposed', 'supervisor.decided', 'task.created', 'task.started',
  'task.done', 'task.verify_passed', 'guardrail.tripped', 'run.started', 'run.succeeded', 'run.failed',
  'task.integrated', 'task.review_approved', 'task.review_rejected',
]

const SENTENCE: Partial<Record<DomainEventType, (p: Record<string, unknown>, n: HappeningNames) => string>> = {
  'workspace.goal_set': (p) => `You asked for: ${str(p, 'request') ?? str(p, 'goal') ?? 'a new goal'}`,
  'supervisor.proposed': (p) => `The Supervisor proposed: ${str(p, 'summary') ?? 'a change'}`,
  'supervisor.decided': (p) => `The Supervisor decided: ${str(p, 'summary') ?? str(p, 'decision') ?? 'something'}`,
  'task.created': (_p, n) => `${quoted(n)} was added to the board`,
  'task.started': (_p, n) => `${who(n)} picked up ${quoted(n)}`,
  'task.done': (_p, n) => `${who(n)} finished ${quoted(n)}`,
  'task.verify_passed': (_p, n) => `${quoted(n)} passed verification`,
  'guardrail.tripped': (_p, n) => `${quoted(n)} is blocked and needs you`,
  'run.started': (_p, n) => `${who(n)} started ${quoted(n)}`,
  'run.succeeded': (_p, n) => `${who(n)} wrapped up ${quoted(n)}`,
  'run.failed': (_p, n) => `${who(n)} hit a failure on ${quoted(n)}`,
  'task.integrated': (_p, n) => `${quoted(n)} was merged`,
  'task.review_approved': (_p, n) => `${who(n)} approved ${quoted(n)}`,
  'task.review_rejected': (_p, n) => `${who(n)} asked for changes on ${quoted(n)}`,
}

/** One HAPPENING_TYPES event, said as a sentence a person reads without knowing the vocabulary
 *  underneath. A type this table does not name (every `run.tool_call`/`run.output` line and
 *  everything else outside the curated families above) falls back to `feedSummary`, the same
 *  fallback the live feed already uses -- so nothing here can ever print a bare `word.word` type. */
export function happeningSentence(type: string, payload: Record<string, unknown>, names: HappeningNames): string {
  const make = SENTENCE[type as DomainEventType]
  return make === undefined ? feedSummary(type, payload) : make(payload, names)
}
