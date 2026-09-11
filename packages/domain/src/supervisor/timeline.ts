import type { ExecutionEvent } from '../events/schema.js'
import type { MemoryStatus } from '../memory/types.js'

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
 *
 * `decision` holds BOTH halves of a decision's life (spec erratum E27): the pending
 * `SupervisorDecision` row that is waiting on a person, and the `supervisor.applied` /
 * `supervisor.resolved` events that record the answer. A decision a person took leaves its trace
 * where it was asked; {@link isResolvedDecision} is how a renderer tells the two apart.
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
  // M48: how the work will be done changed. Not `user_request` even when a person adopted it --
  // what changed is the plan's shape, and `laneFor`'s actor override exists only for task creation.
  'workspace.runbook_adopted': 'plan_change',
  // WORK IN PROGRESS
  'task.started': 'work',
  'task.verifying': 'work',
  'task.review_started': 'work',
  'run.paused': 'work',
  'run.resumed': 'work',
  'slave.message_sent': 'work',
  // M50 R3: the end of one worker's engagement is part of the work story, beside the messages and
  // the pauses -- who was here, and until when. Not `decision`: the Supervisor applies this
  // routinely, and the decision lane is for what a person still has to answer.
  'slave.released': 'work',
  // DECISION REQUIRED -- the two events that record a decision already TAKEN (erratum E27).
  // `supervisor.proposed` and `supervisor.decided` stay off the timeline: the proposal itself is
  // shown as the pending `SupervisorDecision` row, and showing both would double every entry.
  'supervisor.applied': 'decision',
  'supervisor.resolved': 'decision',
  // M49: knowledge the organisation actually verified. The DEFAULT is non-null deliberately (plan
  // erratum E5): `apps/web/src/server/timeline.ts` only QUERIES types whose entry here is non-null,
  // so a lane that exists only inside `laneFor` would never be fetched. `laneFor` narrows this to
  // null for a candidate.
  'memory.recorded': 'verified',
  // A person verifying, correcting or withdrawing knowledge is a decision they took. `laneFor`
  // narrows this to null when the system did it.
  'memory.changed': 'decision',
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
  'supervisor.failed': null,
}

/**
 * What the timeline classifies (spec erratum E27).
 *
 * Four arms, because the DECISION REQUIRED lane has four different things in it and only one of
 * them is an event: a pending `SupervisorDecision`, an unanswered question waiting on a person,
 * and a blocked task are separate rows in separate tables. They get separate arms so a caller
 * never has to dress a question up as a decision to have it classified (Task 2).
 */
export type TimelineSubject =
  | {
      readonly source: 'event'
      readonly type: ExecutionEvent['type']
      readonly actor: 'human' | 'slave' | 'system'
      /** M49 R4 (plan erratum E5): `memory.recorded`'s lane depends on its PAYLOAD -- a candidate
       *  is not a verified result. Optional, so every existing caller compiles unchanged, and read
       *  only by the `memory.recorded` branch of {@link laneFor}. */
      readonly memoryStatus?: MemoryStatus | undefined
    }
  | { readonly source: 'decision' }
  | { readonly source: 'question' }
  | { readonly source: 'blocked_task' }

/** The lane this belongs on, or null for "not on this timeline". Pure and total. */
export function laneFor(subject: TimelineSubject): TimelineLane | null {
  if (subject.source !== 'event') return 'decision'
  if (subject.type === 'task.created' || subject.type === 'task.cancelled') {
    return subject.actor === 'human' ? 'user_request' : 'plan_change'
  }
  // M49 R4: both depend on something `LANE_BY_TYPE` cannot see -- the payload's status for one,
  // the envelope's actor for the other -- exactly as `task.created` depends on the actor above.
  if (subject.type === 'memory.recorded') {
    return subject.memoryStatus === 'verified' ? 'verified' : null
  }
  if (subject.type === 'memory.changed') {
    return subject.actor === 'human' ? 'decision' : null
  }
  return LANE_BY_TYPE[subject.type]
}

/**
 * Whether this entry is a decision that has ALREADY been answered (spec erratum E27).
 *
 * A separate predicate rather than a field on {@link laneFor}'s result, because that result is a
 * string union and widening it to an object would change every caller's shape for a flag only the
 * `decision` lane can use. A renderer asks both questions: `laneFor` for where the entry goes,
 * this for whether to mute it.
 *
 * True for exactly the two events that record an answer. A pending decision, an unanswered
 * question and a blocked task are all still waiting on a person, so all three are false.
 */
export function isResolvedDecision(subject: TimelineSubject): boolean {
  // A `switch` over the discriminant with a `never` default, not a boolean expression (final wave,
  // parked minor): a fifth `TimelineSubject` arm then fails the BUILD here, the way `LANE_BY_TYPE`
  // fails it for a fiftieth event type. An expression would have answered `false` for the new arm
  // and left a renderer silently muting -- or not muting -- something nobody classified.
  switch (subject.source) {
    case 'event':
      return subject.type === 'supervisor.applied' || subject.type === 'supervisor.resolved'
    // All three are still waiting on a person, so none of them is a decision already taken.
    case 'decision':
    case 'question':
    case 'blocked_task':
      return false
    default: {
      const unreachable: never = subject
      return unreachable
    }
  }
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
