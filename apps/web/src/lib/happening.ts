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
  'workspace.goal_set', 'supervisor.proposed', 'supervisor.decided', 'supervisor.applied', 'supervisor.failed',
  'task.created', 'task.started',
  'task.done', 'task.verify_passed', 'guardrail.tripped', 'run.started', 'run.succeeded', 'run.failed',
  'task.integrated', 'task.review_approved', 'task.review_rejected',
]

/**
 * The Supervisor's own catalogue kind, said the way a person reads it (R8) -- the six kinds `act`
 * actually carries out on its own without an escalation (spec §2's "applied" column) get their own
 * words; anything else names the kind rather than inventing a sentence for it.
 *
 * Reads off `p.action` rather than taking the action as its own argument: `supervisor.applied`'s
 * real payload (`applyDecision`, `packages/control/src/supervisor.ts`) is `{ decisionId, action: {
 * kind } }` -- only the kind survives the append, so every other field here is read with `str`,
 * which is `null` for a caller that never gave it one, and this degrades to the bare kind rather
 * than printing "undefined".
 */
function verbPhrase(p: Record<string, unknown>): string {
  const action = p['action']
  const fields = action !== null && typeof action === 'object' ? (action as Record<string, unknown>) : {}
  const kind = str(fields, 'kind')
  switch (kind) {
    case 'retry_task': {
      const title = str(fields, 'title')
      return title === null ? 'retried a task' : `retried "${title}"`
    }
    case 'retry_review': {
      const title = str(fields, 'title')
      return title === null ? 'sent a task back to review' : `sent "${title}" back to review`
    }
    case 'clear_halt':
      return 'cleared the halt'
    case 'request_permission': {
      const kindLabel = str(fields, 'kindLabel')
      const name = str(fields, 'name')
      return kindLabel === null || name === null ? 'granted a permission' : `granted ${kindLabel} to ${name}`
    }
    case 'hire_from_catalog': {
      const name = str(fields, 'name')
      return name === null ? 'hired someone' : `hired ${name}`
    }
    case 'unblock_task':
      return 'unblocked a task'
    case 'steer_run':
      return 'steered a worker'
    default:
      return `applied ${kind ?? 'something'}`
  }
}

const SENTENCE: Partial<Record<DomainEventType, (p: Record<string, unknown>, n: HappeningNames) => string>> = {
  'workspace.goal_set': (p) => `You asked for: ${str(p, 'request') ?? str(p, 'goal') ?? 'a new goal'}`,
  'supervisor.proposed': (p) => `The Supervisor proposed: ${str(p, 'summary') ?? 'a change'}`,
  'supervisor.decided': (p) => `The Supervisor decided: ${str(p, 'summary') ?? str(p, 'decision') ?? 'something'}`,
  'supervisor.applied': (p) => `The Supervisor ${verbPhrase(p)}`,
  'supervisor.failed': (p) => `The Supervisor could not ${verbPhrase(p)}: ${str(p, 'reason') ?? 'unknown'}`,
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
