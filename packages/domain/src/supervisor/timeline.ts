import type { ExecutionEvent } from '../events/schema.js'

/**
 * The six lanes a person reads a project's history in (M45 R2).
 *
 * ORGANISATIONAL events only. `run.tool_call` and `run.output` are what a model said while
 * working, and a timeline that carries them is the live-events river this milestone moved under
 * `Advanced` -- not the story of what the project decided. The Activity page keeps every event,
 * unfiltered, and is one link away.
 *
 * The order is the reading order: what you asked for, what was understood, what changed on the
 * board, what is happening, what needs you, what is finished.
 */
export const TIMELINE_LANES = [
  'user_request',
  'interpretation',
  'plan_change',
  'work',
  'decision',
  'verified',
] as const

export type TimelineLane = (typeof TIMELINE_LANES)[number]

export const LANE_LABEL: Record<TimelineLane, string> = {
  user_request: 'USER REQUEST',
  interpretation: 'SUPERVISOR INTERPRETATION',
  plan_change: 'PLAN CHANGE',
  work: 'WORK IN PROGRESS',
  decision: 'DECISION REQUIRED',
  verified: 'VERIFIED RESULT',
}

/**
 * Every event type on exactly one lane, or on none.
 *
 * `Record<ExecutionEvent['type'], ...>` is load-bearing and is the whole exhaustiveness guarantee
 * R2 asks for: a fiftieth event type fails the BUILD here rather than silently never appearing on
 * a timeline nobody thought to check (plan erratum E5). `null` is a real, deliberate answer -- the
 * event is real, it is on the Activity page, and it is not part of the organisation's story.
 *
 * `task.created` and `task.cancelled` carry their DEFAULT lane here; {@link laneFor} overrides
 * both when the envelope's actor is a person, because a task a human created or cancelled is a
 * request, not a plan change (plan erratum E4).
 */
export const LANE_BY_TYPE: Record<ExecutionEvent['type'], TimelineLane | null> = {
  // USER REQUEST
  'workspace.goal_set': 'user_request',
  // INTERPRETATION -- the delta IS the interpretation; no stored sentence exists (spec §3).
  'workspace.replan_started': 'interpretation',
  'workspace.replanned': 'interpretation',
  // PLAN CHANGE
  'task.created': 'plan_change',
  'task.cancelled': 'plan_change',
  'workspace.plan_created': 'plan_change',
  // WORK IN PROGRESS
  'task.started': 'work',
  'task.verifying': 'work',
  'task.review_started': 'work',
  'run.paused': 'work',
  'run.resumed': 'work',
  'slave.message_sent': 'work',
  // VERIFIED RESULT
  'task.verify_passed': 'verified',
  'task.review_approved': 'verified',
  'task.done': 'verified',
  'task.integrated': 'verified',
  // Everything else: real, kept, and not on this timeline.
  'task.rework': null,
  'task.failed': null,
  'task.verify_failed': null,
  'task.review_rejected': null,
  'task.merge_failed': null,
  'task.unblocked': null,
  'task.dependency_added': null,
  'task.dependency_removed': null,
  'task.worktree_collected': null,
  'run.started': null,
  'run.tool_call': null,
  'run.tool_denied': null,
  'run.output': null,
  'run.pause_requested': null,
  'run.resume_requested': null,
  'run.stopped': null,
  'run.succeeded': null,
  'run.failed': null,
  'slave.message_reassigned': null,
  'slave.profile_changed': null,
  'slave.runtime_roles_changed': null,
  'guardrail.tripped': null,
  'org.changed': null,
  'workspace.company_assigned': null,
  'workspace.settings_changed': null,
  'workspace.created': null,
  'workspace.archived': null,
  'workspace.restored': null,
  'supervisor.decided': null,
  'supervisor.proposed': null,
  'supervisor.applied': null,
  'supervisor.resolved': null,
  'supervisor.failed': null,
}

/** What the timeline classifies: a stored event, or a `SupervisorDecision` waiting on a person. */
export type TimelineSubject =
  | {
      readonly source: 'event'
      readonly type: ExecutionEvent['type']
      readonly actor: 'human' | 'slave' | 'system'
    }
  | { readonly source: 'decision' }

/** The lane this belongs on, or null for "not on this timeline". Pure and total. */
export function laneFor(subject: TimelineSubject): TimelineLane | null {
  if (subject.source === 'decision') return 'decision'
  if (subject.type === 'task.created' || subject.type === 'task.cancelled') {
    return subject.actor === 'human' ? 'user_request' : 'plan_change'
  }
  return LANE_BY_TYPE[subject.type]
}

/** The three numbers a `workspace.replanned` payload carries, plus how many tasks survived it. */
export interface ReplanSentenceFacts {
  readonly version: number
  readonly added: readonly string[]
  readonly proposedCancellations: readonly string[]
  readonly kept: number
}

/**
 * What the Supervisor understood, said in the only words the system honestly has: the delta the
 * re-plan produced (spec R2, and §3's rejection of a stored model-written sentence).
 *
 * Pure, so it can be tested with literals: the caller resolves ids to titles, because the payload
 * carries only ids (plan erratum E21). An id with no title left falls back to the id -- a task
 * deleted since the re-plan is still part of what happened.
 */
export function replanSentence(
  facts: ReplanSentenceFacts,
  titles: Readonly<Record<string, string>>,
): string {
  const name = (id: string): string => titles[id] ?? id
  const parts: string[] = []
  if (facts.added.length > 0) parts.push(`+${facts.added.map(name).join(', ')}`)
  if (facts.proposedCancellations.length > 0) {
    parts.push(`proposes cancelling ${facts.proposedCancellations.map(name).join(', ')}`)
  }
  if (parts.length === 0) parts.push('nothing to add or cancel')
  return `understood v${String(facts.version)}: ${parts.join('; ')}; ${String(facts.kept)} kept`
}
