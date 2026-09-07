import type { JournalEntry } from '../core/journal.js'
import type { SoftwareState } from './state.js'

/** Design §3.6. Ten whole numbers: nothing here is an average that drifts, a ratio, or an
 *  estimate — `avgLeadDays` is rounded to an integer for exactly that reason. */
export interface SoftwareMetrics {
  readonly deliveredTasks: number
  readonly onTimeTasks: number
  readonly lateTasks: number
  readonly avgLeadDays: number
  readonly reworkTasks: number
  readonly defectIncidents: number
  readonly queueMaxLength: number
  readonly reviewBacklogMax: number
  readonly idleEngineerDays: number
  readonly openTasks: number
}

function eventType(entry: JournalEntry): string | null {
  const event = entry.payload['event']
  return typeof event === 'object' && event !== null && 'type' in event ? String((event as { type: unknown }).type) : null
}

function actionType(entry: JournalEntry): string | null {
  const action = entry.payload['action']
  return typeof action === 'object' && action !== null && 'type' in action ? String((action as { type: unknown }).type) : null
}

/** The two peaks are read as running maxima over the journal, not sampled at the day close: a
 *  queue is longest the moment work lands on it, and a review backlog is largest the moment the
 *  day's finishes arrive — both are drained again by the lead and the reviewer before the day
 *  ends, so a close-of-day sample measures the leftovers rather than the peak (and would report
 *  zero for every policy-B run, which reviews everything the same day it finishes). Both walks
 *  are exact: every arrival and every departure is its own journal entry.
 *
 *  Everything else here is the end-of-run state, the same split `tradeMetrics` uses. */
export function softwareMetrics(entries: readonly JournalEntry[], state: SoftwareState): SoftwareMetrics {
  let defectIncidents = 0
  let queue = 0
  let reviewBacklog = 0
  let queueMaxLength = 0
  let reviewBacklogMax = 0
  for (const entry of entries) {
    const event = entry.kind === 'event' || entry.kind === 'external_event' ? eventType(entry) : null
    if (event === 'defect_surfaced' && entry.payload['incidentTaskId'] !== undefined) defectIncidents += 1
    // Onto the queue: a request product accepted, or an incident — injected or surfaced from a
    // defect — which skips product and arrives queued (design §3.3).
    if (entry.kind === 'action_applied' && actionType(entry) === 'accept_request') queue += 1
    if (event === 'incident' && entry.payload['taskId'] !== undefined) queue += 1
    if (event === 'defect_surfaced' && entry.payload['incidentTaskId'] !== undefined) queue += 1
    if (entry.kind === 'action_applied' && actionType(entry) === 'assign_task') queue -= 1
    if (event === 'task_finished' && entry.payload['outcome'] === 'in_review') reviewBacklog += 1
    if (entry.kind === 'action_applied' && actionType(entry) === 'review_task') reviewBacklog -= 1
    queueMaxLength = Math.max(queueMaxLength, queue)
    reviewBacklogMax = Math.max(reviewBacklogMax, reviewBacklog)
  }
  const delivered = state.tasks.filter((t) => t.status === 'done')
  const leadDays = delivered.reduce((sum, t) => sum + ((t.doneDay ?? 0) - t.requestedDay), 0)
  return {
    deliveredTasks: delivered.length,
    onTimeTasks: delivered.filter((t) => (t.doneDay ?? 0) <= t.dueDay).length,
    lateTasks: delivered.filter((t) => (t.doneDay ?? 0) > t.dueDay).length,
    avgLeadDays: delivered.length === 0 ? 0 : Math.round(leadDays / delivered.length),
    reworkTasks: state.tasks.filter((t) => t.rework > 0).length,
    defectIncidents,
    queueMaxLength,
    reviewBacklogMax,
    idleEngineerDays: state.idleEngineerDays,
    openTasks: state.tasks.filter((t) => t.status !== 'done').length,
  }
}
