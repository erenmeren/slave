import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { listDecisions, type DecisionView } from '@slave-of-ai/control'
import {
  LANE_BY_TYPE,
  LANE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
  isResolvedDecision,
  laneFor,
  replanSentence,
  type MemoryStatus,
  type MemoryType,
  type TimelineLane,
  type TimelineSubject,
} from '@slave-of-ai/domain'
import { readableEventType } from '../lib/eventLabels'
import { buildNeedsYou, type NeedsYouItem } from './needsYou'

/** How many organisational events one timeline page reads. */
export const TIMELINE_LIMIT_DEFAULT = 40
/** The ceiling, matching `ACTIVITY_PAGE_LIMIT_MAX` -- one idea of "a page" across the two rivers. */
export const TIMELINE_LIMIT_MAX = 200

/**
 * One entry on the Supervisor timeline (M45 R2): a stored organisational event, or one of the three
 * rows that are still waiting on a person -- a pending `SupervisorDecision`, an unanswerable
 * question, a blocked task.
 *
 * `title` is the sentence a person reads; `detail` is the second line when there is one. The raw
 * event type stays on `eventType` so the page can put it on `data-event-type` and in `title` --
 * `docs/ia.md` rule 3, the same contract every other projected surface keeps.
 */
export interface TimelineEntry {
  /** `event-<seq>`, `decision-<id>`, `question-<id>` or `blocked-<taskId>`. Stable, and what the
   *  gate names an entry by. */
  readonly key: string
  readonly lane: TimelineLane
  readonly laneLabel: string
  /** ISO. Merged across every source so the river is one ordered story. */
  readonly at: string
  readonly title: string
  readonly detail: string | null
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly eventType: DomainEventType | null
  /** The whole decision row, so the DECISION REQUIRED lane can render `ProposalRow` unchanged.
   *  Null for every other kind of entry, a resolved decision's own event included. */
  readonly decision: DecisionView | null
  /** The question this entry is, so the lane can post an answer to `/messages/:id/answer`. */
  readonly messageId: string | null
  /** `isResolvedDecision`: a decision a person ALREADY took, kept on the lane where it was asked
   *  and rendered muted (spec erratum E27). False for everything still waiting. */
  readonly resolved: boolean
  /** How many earlier entries this one stands for -- the "+N earlier" disclosure. 0 for most. */
  readonly collapsedCount: number
}

/** The DB enum values `LANE_BY_TYPE` gives a lane to. Derived, so the query and the classification
 *  can never disagree about what a timeline event is. `task.created`/`task.cancelled` carry a
 *  non-null default lane here, so `laneFor`'s human override never widens this set. */
const TIMELINE_DB_TYPES = (Object.keys(LANE_BY_TYPE) as DomainEventType[])
  .filter((type) => LANE_BY_TYPE[type] !== null)
  .map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type])

/** A needs-you item's kind IS a `TimelineSubject` arm, one for one -- Task 1 added the `question`
 *  and `blocked_task` arms precisely so this read model never has to dress a question up as a
 *  decision (spec erratum E27). `integrate` has no arm: there is no web integration verb, so that
 *  item is a LINK on the board rather than a row on the timeline (erratum E11). */
const SUBJECT_BY_ITEM_KIND: Readonly<Record<NeedsYouItem['kind'], TimelineSubject | null>> = {
  decision: { source: 'decision' },
  question: { source: 'question' },
  blocked_task: { source: 'blocked_task' },
  integrate: null,
}

/**
 * The project's story, newest first (M45 R2).
 *
 * ONE event query with a type filter -- the idiom `buildActivityHistory` already uses -- plus the
 * queue of things waiting on a person and the board's titles. Never one query per entry: this
 * builder runs on every SSE-driven refetch of the Overview, several times a second while a run is
 * live.
 *
 * `options.needsYou` and `options.decisions` are how `buildOverviewSnapshot` hands over reads it
 * has ALREADY made. Building the queue twice would mean two `loadSupervisorWorld` transactions per
 * refetch for one list; listing the decisions twice would fetch every pending row's JSON twice.
 * Both have a fallback read, so the function is still callable from a workspace id alone.
 *
 * The decisions are listed ONCE here and only for their BODIES: the queue says which decisions are
 * waiting, and this read is what puts the whole `DecisionView` on the entry so the lane can render
 * `ProposalRow` unchanged.
 *
 * Refreshed by the stream the page already owns: this is a field on `OverviewSnapshot`, so
 * `useWorkspaceStream`'s debounced refetch of `/api/w/:id/overview` updates it with no second
 * `EventSource` and no polling (M45 plan erratum E19).
 */
export async function buildSupervisorTimeline(
  workspaceId: string,
  options: {
    readonly limit?: number
    readonly needsYou?: readonly NeedsYouItem[]
    readonly decisions?: readonly DecisionView[]
  } = {},
): Promise<readonly TimelineEntry[]> {
  const take = Math.min(options.limit ?? TIMELINE_LIMIT_DEFAULT, TIMELINE_LIMIT_MAX)

  const [rows, decisions, tasks, waiting] = await Promise.all([
    prisma.executionEvent.findMany({
      where: { workspaceId, type: { in: TIMELINE_DB_TYPES } },
      orderBy: { seq: 'desc' },
      take,
    }),
    options.decisions ?? listDecisions(workspaceId, { pending: true }),
    prisma.task.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
    options.needsYou ?? buildNeedsYou(workspaceId),
  ])

  const titles: Record<string, string> = Object.fromEntries(tasks.map((task) => [task.id, task.title]))
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]))

  const entries: TimelineEntry[] = []

  // WORK IN PROGRESS collapses a task's message chatter to its latest, because a worker that
  // reported five times is one thing happening, not five (spec R2).
  const messagesSeenPerTask = new Map<string, number>()

  for (const row of rows) {
    const type = (DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type) as DomainEventType
    const payload = row.payload as Record<string, unknown>
    const memoryStatus = memoryStatusOf(type, payload)
    const subject: TimelineSubject = {
      source: 'event',
      type,
      actor: row.actor as 'human' | 'slave' | 'system',
      // M49 R4 (plan erratum E5): the lane of a `memory.recorded` is its payload's status.
      ...(memoryStatus === null ? {} : { memoryStatus }),
    }
    const lane = laneFor(subject)
    if (lane === null) continue

    if (type === 'slave.message_sent') {
      const key = row.taskId ?? 'no-task'
      const seen = messagesSeenPerTask.get(key) ?? 0
      messagesSeenPerTask.set(key, seen + 1)
      // Rows arrive newest-first, so the FIRST one seen for a task is the latest; the rest only
      // raise its count.
      if (seen > 0) {
        const keptIndex = entries.findIndex(
          (entry) => entry.eventType === 'slave.message_sent' && entry.taskId === row.taskId,
        )
        const kept = entries[keptIndex]
        if (kept !== undefined) {
          entries[keptIndex] = { ...kept, collapsedCount: kept.collapsedCount + 1 }
        }
        continue
      }
    }

    entries.push({
      key: `event-${String(row.seq)}`,
      lane,
      laneLabel: LANE_LABEL[lane],
      at: row.ts.toISOString(),
      title: titleFor(type, payload, titles),
      detail: detailFor(type, payload),
      taskId: row.taskId,
      taskTitle: row.taskId === null ? null : (titles[row.taskId] ?? null),
      eventType: type,
      decision: null,
      messageId: null,
      resolved: isResolvedDecision(subject),
      collapsedCount: 0,
    })
  }

  // The DECISION REQUIRED lane's live half: the same queue the brief's tile counts, so the number
  // and the list can never disagree (spec R2's "each with its existing inline action").
  for (const item of waiting) {
    const subject = SUBJECT_BY_ITEM_KIND[item.kind]
    if (subject === null) continue
    const lane = laneFor(subject)
    if (lane === null) continue
    entries.push({
      key: `${item.kind === 'blocked_task' ? 'blocked' : item.kind}-${item.taskId ?? item.id}`,
      lane,
      laneLabel: LANE_LABEL[lane],
      at: item.since,
      title: item.title,
      detail: item.decisionId === null ? null : (decisionById.get(item.decisionId)?.rationale ?? null),
      taskId: item.taskId,
      taskTitle: item.taskId === null ? null : (titles[item.taskId] ?? null),
      eventType: null,
      decision: item.decisionId === null ? null : (decisionById.get(item.decisionId) ?? null),
      messageId: item.messageId,
      resolved: isResolvedDecision(subject),
      collapsedCount: 0,
    })
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/**
 * The memory status this row's subject carries, or `null` for every row that carries none (M49 R4,
 * plan erratum E5).
 *
 * Narrowed to the ONE type the field exists for (fix round 1): this used to stamp `memoryStatus`
 * from any payload with a string `status`, so an unrelated event type that grew such a field would
 * silently start feeding `laneFor`'s `memory.recorded` branch a status from somewhere else. The
 * value is checked against the vocabulary too -- a hand-edited row saying `status: 'shipped'` is
 * not a memory status, and `null` (no lane) is the honest reading of it.
 *
 * Exported because it is PURE: the narrowing is a reading of a payload, provable without a row.
 */
export function memoryStatusOf(type: DomainEventType, payload: Record<string, unknown>): MemoryStatus | null {
  if (type !== 'memory.recorded') return null
  const status = payload['status']
  return typeof status === 'string' && (MEMORY_STATUSES as readonly string[]).includes(status)
    ? (status as MemoryStatus)
    : null
}

/**
 * The sentence, per type. Everything a MODEL or a person wrote is passed through as data -- this
 * builds a string, and the component interpolates it as JSX children.
 */
function titleFor(
  type: DomainEventType,
  payload: Record<string, unknown>,
  titles: Readonly<Record<string, string>>,
): string {
  switch (type) {
    case 'workspace.goal_set': {
      // R3: when a person asked for a change, the request IS the entry. A whole-goal set has no
      // request and says what it did instead -- inventing a sentence for it would put words in
      // somebody's mouth.
      const request = payload['request']
      if (typeof request === 'string' && request !== '') return request
      const version = payload['version']
      return `set the goal to v${typeof version === 'number' ? String(version) : '1'}`
    }
    case 'workspace.replan_started': {
      const version = payload['version']
      return `reading the change to v${typeof version === 'number' ? String(version) : '?'}`
    }
    case 'workspace.replanned': {
      const added = asIds(payload['added'])
      const cancels = asIds(payload['proposedCancellations'])
      // "How many of the board's tasks this re-plan LEFT STANDING" -- `ReplanSentenceFacts`' own
      // reading of `kept` ("how many tasks survived it"), computed from the titles map this
      // builder already holds. A DISPLAY number, never a decision: the board is read now and the
      // re-plan happened then, so a task added or cancelled since moves it. The payload carries no
      // count of its own, and inventing a stored one would be a second thing to keep in step.
      const kept = Math.max(Object.keys(titles).length - cancels.length, 0)
      return replanSentence(
        {
          version: typeof payload['version'] === 'number' ? payload['version'] : 0,
          added,
          proposedCancellations: cancels,
          kept,
        },
        titles,
      )
    }
    // M48 R5/R7: a runbook adopted, or stopped. The payload's `title` is not a field this event
    // carries, so without a case of its own it would read as its own type name on the PLAN CHANGE
    // lane -- and this is the one entry that says how the project decided to work.
    case 'workspace.runbook_adopted': {
      const name = payload['name']
      const cleared = payload['cleared'] === true
      // The NAME, never the key: this line is read on the Overview's PLAN CHANGE lane.
      const what = typeof name === 'string' && name !== '' ? name : 'a runbook'
      return cleared ? `stopped following ${what}` : `adopted ${what} as the way this project works`
    }
    // M49 R4/R6: what was learnt, in words. The payload carries no `title` field, so without a
    // case of its own this would read as its own type name on the VERIFIED lane.
    case 'memory.recorded': {
      const memoryType = payload['type']
      const label = typeof memoryType === 'string' && memoryType in MEMORY_TYPE_LABEL
        ? MEMORY_TYPE_LABEL[memoryType as MemoryType]
        : 'Knowledge'
      return `learnt: ${label.toLowerCase()}`
    }
    case 'memory.changed': {
      const to = payload['to']
      const label = typeof to === 'string' && to in MEMORY_STATUS_LABEL ? MEMORY_STATUS_LABEL[to as MemoryStatus] : 'changed'
      const reason = payload['reason']
      return typeof reason === 'string' && reason !== ''
        ? `knowledge ${label.toLowerCase()}: ${reason}`
        : `knowledge ${label.toLowerCase()}`
    }
    // M50 R3: a temporary specialist's engagement ended. The payload carries no `title`, so without
    // a case of its own this would read as its own type name on the WORK lane.
    case 'slave.released': {
      const name = payload['name']
      const who = typeof name === 'string' && name !== '' ? name : 'a temporary specialist'
      const reason = payload['reason']
      return typeof reason === 'string' && reason !== '' ? `released ${who}: ${reason}` : `released ${who}`
    }
    default: {
      const title = payload['title']
      return typeof title === 'string' && title !== '' ? title : readableEventType(type)
    }
  }
}

/**
 * The second line, when the payload carries one. A FIELD loop rather than a per-type table:
 * erratum E5 declined a label table for the ~49 event types, and the same ruling applies here.
 *
 * ONE type is named, and only because its payload carries two different things (final wave I3): a
 * `workspace.goal_set` written by a REQUEST already has that request as its title, and its `goal`
 * is the whole composed document -- objective, every heading, every earlier dated bullet. Printing
 * that as the second line of a one-line-per-entry river buried the rest of the story under one
 * entry. The version is the one fact the title does not carry, so that is what the second line
 * says. A goal set with no request keeps the goal as its detail: there the title is `set the goal
 * to v1` and the document IS what happened (the component clamps it to two lines).
 */
function detailFor(type: DomainEventType, payload: Record<string, unknown>): string | null {
  if (type === 'workspace.goal_set' && typeof payload['request'] === 'string' && payload['request'] !== '') {
    const version = payload['version']
    return typeof version === 'number' ? `v${String(version)}` : null
  }
  for (const field of ['goal', 'body', 'reason', 'branch', 'summary'] as const) {
    const value = payload[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function asIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
