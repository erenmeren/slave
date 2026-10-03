import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { handOffViews, listDecisions, type DecisionView } from '@slave-of-ai/control'
import {
  BREAKER_TRIP_LABEL,
  BROKER_OP_LABEL,
  BROKER_REFUSAL_LABEL,
  LANE_BY_TYPE,
  LANE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
  handOffFromName,
  isResolvedDecision,
  laneFor,
  originLabel,
  parseExternalOrigin,
  replanSentence,
  type BreakerTripKind,
  type BrokerOp,
  type BrokerRefusalReason,
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
  const handOffFrom = await packageLessHandOffNames(workspaceId, rows)
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]))

  const entries: TimelineEntry[] = []

  // WORK IN PROGRESS collapses a task's message chatter to its latest, because a worker that
  // reported five times is one thing happening, not five (spec R2).
  const messagesSeenPerTask = new Map<string, number>()

  for (const row of rows) {
    const type = (DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type) as DomainEventType
    const payload = row.payload as Record<string, unknown>
    const memoryStatus = memoryStatusOf(type, payload)
    const retryCause = retryCauseOf(type, payload)
    const subject: TimelineSubject = {
      source: 'event',
      type,
      actor: row.actor as 'human' | 'slave' | 'system',
      // M49 R4 (plan erratum E5): the lane of a `memory.recorded` is its payload's status.
      ...(memoryStatus === null ? {} : { memoryStatus }),
      // Final wave M5: a branch-moved retry is the goal pass's, not a person's request.
      ...(retryCause === null ? {} : { retryCause }),
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
      title: titleFor(type, payload, titles, handOffFrom),
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
 * Pre-flight F65 (human cards plan A carry, plan B Task 8): who each package-less hand-off on this
 * page came from, by its id -- named the way the goal report and the workers' prompts name it
 * (`handOffViews` + `handOffFromName`): a person's request or late answer as the operator's, a
 * worker's late answer by its seat, the Supervisor's as the conductor's. A hand-off from a package
 * is named by its package off the event alone, so only the package-less ones are read: one query
 * for their rows, and `handOffViews`' own reads only when one is a late answer. None when the page
 * holds no such event.
 */
async function packageLessHandOffNames(
  workspaceId: string,
  rows: readonly { readonly type: string; readonly payload: unknown }[],
): Promise<ReadonlyMap<string, string>> {
  const ids = rows.flatMap((row) => {
    if (row.type !== EVENT_TYPE_BY_DOMAIN_TYPE['workspace.package_handed_off']) return []
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const id = payload['handOffId']
    return payload['fromPackage'] == null && typeof id === 'string' ? [id] : []
  })
  if (ids.length === 0) return new Map()
  const handOffs = await prisma.packageHandOff.findMany({
    where: { workspaceId, id: { in: [...new Set(ids)] } },
    select: { id: true, workspaceId: true, source: true, sourceKey: true, fromPackageKey: true, path: true, packageKey: true, change: true },
  })
  const views = await handOffViews(handOffs)
  return new Map(views.map((view) => [view.id, handOffFromName(view)] as const))
}

/**
 * Final wave M5: `workspace.goal_retried`'s `cause`, or `null` for every other row and for a retry
 * that carries none (a person's). Narrowed to the one type and the one value, like
 * {@link memoryStatusOf} below. Exported because it is PURE.
 */
export function retryCauseOf(type: DomainEventType, payload: Record<string, unknown>): 'branch_moved' | null {
  return type === 'workspace.goal_retried' && payload['cause'] === 'branch_moved' ? 'branch_moved' : null
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
  handOffFrom: ReadonlyMap<string, string>,
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
    // Conductor R1 (2026-09-28): a goal version's requirements, extracted. The payload carries no
    // `title`, so without a case of its own this would read as its own type name on the
    // INTERPRETATION lane.
    case 'workspace.requirements_set': {
      const version = payload['version']
      const count = payload['count']
      const v = typeof version === 'number' ? String(version) : '?'
      const n = typeof count === 'number' ? count : 0
      return `set the requirements for goal v${v} (${n} item${n === 1 ? '' : 's'})`
    }
    // Conductor R2/R3: the size decision recorded, its packages materialised as tasks -- the
    // conductor's own `workspace.plan_created`.
    case 'workspace.conducted': {
      const version = payload['version']
      const v = typeof version === 'number' ? String(version) : '?'
      const mode = payload['mode']
      const packages = asIds(payload['packages'])
      const what = mode === 'partitioned' ? `partitioned into ${packages.length} package${packages.length === 1 ? '' : 's'}` : 'kept as a single package'
      return `conducted goal v${v}: ${what}`
    }
    // Conductor Plan 4a: a goal version's gate passed, and its branch reached the base branch.
    case 'workspace.goal_accepted': {
      const version = payload['version']
      return `accepted goal v${typeof version === 'number' ? String(version) : '?'}`
    }
    case 'workspace.goal_merged': {
      const version = payload['version']
      const into = payload['into']
      return `merged goal v${typeof version === 'number' ? String(version) : '?'} into ${typeof into === 'string' ? into : 'the base branch'}`
    }
    case 'workspace.goal_abandoned': {
      const version = payload['version']
      return `abandoned goal v${typeof version === 'number' ? String(version) : '?'}`
    }
    // Conductor Plan 4b (spec R8): a verification round starting. The payload carries no `title`,
    // so without a case of its own this would read as its own type name on the WORK lane.
    case 'workspace.verification_started': {
      const version = payload['version']
      const round = payload['round']
      const v = typeof version === 'number' ? String(version) : '?'
      const r = typeof round === 'number' ? String(round) : '?'
      return `verifying goal v${v} (round ${r})`
    }
    // Conductor Plan 4b (spec R8/R9): a verification round's verdict. The payload carries no
    // `title`, so without a case of its own this would read as its own type name on the VERIFIED
    // lane.
    case 'workspace.verified': {
      const version = payload['version']
      const round = payload['round']
      const fail = payload['fail']
      const v = typeof version === 'number' ? String(version) : '?'
      const r = typeof round === 'number' ? String(round) : '?'
      const f = typeof fail === 'number' ? fail : 0
      return `verified goal v${v} round ${r}: ${f} failed`
    }
    // Conductor Plan 4b (plan D6/D7): the verification loop ended without acceptance, or the
    // version's final merge failed. `reason` is the second line (`detailFor`'s field loop already
    // reads it).
    case 'workspace.goal_needs_human': {
      const version = payload['version']
      return `goal v${typeof version === 'number' ? String(version) : '?'} needs a person`
    }
    // Conductor Plan 4b (plan D9): a person's retry-goal, with a fresh round window.
    case 'workspace.goal_retried': {
      const version = payload['version']
      const v = typeof version === 'number' ? String(version) : '?'
      // Final wave M5: the goal pass's own retry, after the integration branch moved.
      return payload['cause'] === 'branch_moved' ? `goal v${v} went back to verification` : `retried goal v${v}`
    }
    // Skeleton spec S7: one smoke attempt. No `title` in the payload, so without a case it would
    // read as its own type name on the VERIFIED lane.
    case 'workspace.smoke_run': {
      const version = payload['version']
      const round = payload['round']
      const outcome = payload['outcome']
      const v = typeof version === 'number' ? String(version) : '?'
      const r = typeof round === 'number' ? String(round) : '?'
      return `smoke goal v${v} round ${r}: ${typeof outcome === 'string' ? outcome.replace('_', ' ') : '?'}`
    }
    // Plan B D11: the smoke fix handed from integration to the skeleton.
    case 'workspace.smoke_handed_off': {
      const version = payload['version']
      const to = payload['toPackage']
      return `goal v${typeof version === 'number' ? String(version) : '?'}: smoke fix handed to ${typeof to === 'string' ? to : '?'}`
    }
    // Supervisor-as-conductor spec C2: one package handed work to another. A package-less one is
    // named by `packageLessHandOffNames` (pre-flight F65); a row that is gone falls back to the
    // event's own source -- a person's as the operator's, any other as the conductor's.
    case 'workspace.package_handed_off': {
      const version = payload['version']
      const from = payload['fromPackage']
      const to = payload['toPackage']
      const handOffId = payload['handOffId']
      const named = typeof handOffId === 'string' ? handOffFrom.get(handOffId) : undefined
      const who = typeof from === 'string' ? from : (named ?? (payload['source'] === 'person' ? 'the operator' : 'the conductor'))
      return `goal v${typeof version === 'number' ? String(version) : '?'}: ${who} handed work to ${typeof to === 'string' ? to : 'no package'}`
    }
    // Human cards H1: a question stopped waiting. Every underscore (pre-flight F68): `timed_out`
    // reads "timed out", and a later reason with two underscores would not keep its second.
    case 'slave.question_closed': {
      const reason = payload['reason']
      return `question ${typeof reason === 'string' ? reason.replaceAll('_', ' ') : 'closed'}`
    }
    // Human cards plan B D9: a worker's note -- information, never a card. Its words are the detail.
    case 'workspace.package_noted': {
      const version = payload['version']
      const packageKey = payload['packageKey']
      return `goal v${typeof version === 'number' ? String(version) : '?'}: ${typeof packageKey === 'string' ? packageKey : 'a package'} left a note`
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
    // M51 R2: the payload carries no `title`, so without a case of its own this would read as its
    // own type name on the WORK lane.
    case 'run.breaker': {
      const level = payload['level']
      const trip = payload['trip']
      const word = level === 'constrained' ? 'took its remaining tool budget away' : 'told it to stop and rethink'
      const because =
        typeof trip === 'string' && trip in BREAKER_TRIP_LABEL
          ? BREAKER_TRIP_LABEL[trip as BreakerTripKind].toLowerCase()
          : 'going in circles'
      return `${word} (${because})`
    }
    // M50 R3: a temporary specialist's engagement ended. The payload carries no `title`, so without
    // a case of its own this would read as its own type name on the WORK lane.
    case 'slave.released': {
      const name = payload['name']
      const who = typeof name === 'string' && name !== '' ? name : 'a temporary specialist'
      const reason = payload['reason']
      return typeof reason === 'string' && reason !== '' ? `released ${who}: ${reason}` : `released ${who}`
    }
    // M52 R3/R5: all three are on the WORK lane and none carries a `title`, so without a case each
    // would read as its own type name. The environment and the worker's name are on the payloads;
    // the credential, the command and the output are on none of them.
    case 'broker.executed': {
      const op = payload['op']
      const label = typeof op === 'string' && op in BROKER_OP_LABEL ? BROKER_OP_LABEL[op as BrokerOp] : 'ran an operation'
      const environment = payload['environment']
      const exitCode = payload['exitCode']
      const where = typeof environment === 'string' && environment !== '' ? ` to ${environment}` : ''
      return exitCode === 0 ? `${label.toLowerCase()}${where}` : `${label.toLowerCase()}${where} -- and it failed`
    }
    case 'broker.refused': {
      const op = payload['op']
      const label = typeof op === 'string' && op in BROKER_OP_LABEL ? BROKER_OP_LABEL[op as BrokerOp] : 'an operation'
      const reason = payload['reason']
      const because =
        typeof reason === 'string' && reason in BROKER_REFUSAL_LABEL
          ? BROKER_REFUSAL_LABEL[reason as BrokerRefusalReason].toLowerCase()
          : 'it was refused'
      return `refused ${label.toLowerCase()}: ${because}`
    }
    case 'permission.changed': {
      const name = payload['name']
      const who = typeof name === 'string' && name !== '' ? name : 'a worker'
      // The LABEL, off the payload: a row read a year from now must still say what it was about in
      // the vocabulary of the day it was written (`docs/ia.md` rule 3).
      const kindLabel = payload['kindLabel']
      const what = typeof kindLabel === 'string' && kindLabel !== '' ? kindLabel.toLowerCase() : 'an operation'
      const to = payload['to']
      if (to === 'allow') return `let ${who} ${what}`
      if (to === 'deny') return `stopped ${who} being able to ${what}`
      return `took back the decision about ${who} and ${what}`
    }
    case 'staffing.preference_changed': {
      const capabilityLabel = payload['capabilityLabel']
      const what = typeof capabilityLabel === 'string' && capabilityLabel !== '' ? capabilityLabel.toLowerCase() : 'a capability'
      const to = payload['to']
      if (to === null) return `stopped asking for anybody in particular on ${what}`
      const named = typeof to === 'object' && to !== null ? (to as { templateName?: unknown; model?: unknown }) : {}
      const who =
        typeof named.templateName === 'string' && named.templateName !== ''
          ? named.templateName
          : typeof named.model === 'string' && named.model !== ''
            ? named.model
            : 'somebody'
      return `asked for ${who} on ${what}`
    }
    // M54 R9: neither payload carries a `title`, so without a case each would read as its own type
    // name. The kind's LABEL and the origin's SENTENCE, both off the payload -- no join, and a row
    // read a year from now still says what it was about in the vocabulary of the day it was written.
    case 'external.received': {
      const kindLabel = payload['kindLabel']
      const what = typeof kindLabel === 'string' && kindLabel !== '' ? kindLabel.toLowerCase() : 'an external event'
      const origin = parseExternalOrigin(payload['origin'])
      return origin === null ? `heard about ${what}` : `heard about ${what} ${originLabel(origin)}`
    }
    case 'external.actioned': {
      const version = payload['goalVersion']
      const origin = parseExternalOrigin(payload['origin'])
      const where = origin === null ? '' : ` ${originLabel(origin)}`
      return `changed the requirement to v${typeof version === 'number' ? String(version) : '?'}${where}`
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
  // Human cards plan B D9: a note's own words, as a JSX child like every other quoted detail.
  if (type === 'workspace.package_noted' && typeof payload['note'] === 'string' && payload['note'] !== '') return payload['note']
  for (const field of ['goal', 'body', 'reason', 'branch', 'summary'] as const) {
    const value = payload[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function asIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
