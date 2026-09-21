import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { listSupervisorMessages, type SupervisorMessageView } from '@slave-of-ai/control'
import type { ChatAttachment, Tier } from '@slave-of-ai/domain'
import { feedSummary } from '../lib/feedSummary'

/**
 * One bubble in the panel. `who` decides which side it is drawn on and which shape its corners
 * take (README "Supervisor panel"); `decisionId` is how a card is matched onto the message it
 * belongs inside, from the pending-decisions read the page already makes.
 *
 * TWO SOURCES, one shape (F R1): the six event families this view has always read, and the
 * conversation's own `SupervisorMessage` rows. Everything a row has and an event has not is
 * OPTIONAL and absent on an event — a status, a cost and a sourced chip are facts about a turn,
 * and an event has none of them to report. `id` stays unique across both (`msg:` on a chat row,
 * the event's `seq` on an event), so a key or a scroll target can never collide.
 */
export interface SupervisorMessage {
  readonly id: string
  readonly who: 'operator' | 'supervisor'
  readonly text: string
  /** ISO. */
  readonly at: string
  /** The small mono chips under a message — a goal version, a task id. Never more than two. */
  readonly refs: readonly string[]
  readonly decisionId: string | null
  /** The `SupervisorMessage` row's own id, on a chat row only — what a retry or a scroll target
   *  names, and how a reader tells a conversation row from an event row. */
  readonly messageId?: string
  /** R2: `answering` is what the panel draws as "thinking", `failed` is a turn nothing answered. */
  readonly status?: 'sent' | 'answering' | 'answered' | 'failed'
  /** R6: what the person attached, by repository path. */
  readonly attachments?: readonly ChatAttachment[]
  /** R3: what this reply asked for, each with the decision it became and the tier that decided
   *  whether it was applied or is waiting. The ACTION's kind rather than the whole action: a card
   *  names what was asked for, and the decision row is where the rest of it lives. */
  readonly actions?: readonly { readonly decisionId: string; readonly tier: Tier; readonly kind: string }[]
  /** What the turn cost, or `null` when nobody could price it (erratum E2 — a Cursor turn). */
  readonly costUsd?: number | null
  /** R2's chip: every citation this reply made checked out, and it made at least one. */
  readonly sourced?: boolean
  /** RAW (`no_decider_for_provider`, `budget_exhausted`, `turn_unreadable`), never a sentence:
   *  the panel owns the wording, and a reason stored months ago must still be readable by
   *  whatever renders it then. */
  readonly failureReason?: string | null
}

/** One conversation. `id` IS the local calendar day (`YYYY-MM-DD`), which is what makes this a
 *  grouping rather than a table (M57 R9). */
export interface SupervisorThread {
  readonly id: string
  readonly title: string
  /** What the `≡` list shows on the right of a row: `today`, `yesterday`, or the date. */
  readonly when: string
  readonly messages: readonly SupervisorMessage[]
}

/**
 * The six families that ARE the conversation (M57 R9).
 *
 * A conversation between an operator and the Supervisor is: what the operator asked for
 * (`workspace.goal_set` carrying the `request` M45 R3 put on it), what the Supervisor proposed,
 * what it decided, what became of a proposal, what it managed to do and what it could not. Nothing
 * else is addressed to a person. A run starting is activity, and `/w/:id/activity` is where the
 * whole river is.
 */
const THREAD_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set',
  'supervisor.proposed',
  'supervisor.decided',
  'supervisor.resolved',
  'supervisor.applied',
  'supervisor.failed',
]

/** `YYYY-MM-DD` in the SERVER's own zone — the same zone the timestamps beside each message are
 *  formatted in, so a message can never fall in a thread dated differently from its own clock.
 *  NOTE: the bubble's own clock time is formatted client-side, in the BROWSER's zone
 *  (`SupervisorThreadPanel.tsx`'s `toLocaleTimeString()`), so the day this function buckets a
 *  message into and the time printed beside it are not guaranteed to agree across a timezone. */
// Exported for `activityDigest.ts` (Task 7, controller ruling): the digest's day grouping and
// `when` label are this same function, reused rather than copied so the two readers can never
// bucket the same event into different days.
export function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

export function whenLabel(day: string, now: Date): string {
  const today = localDay(now)
  if (day === today) return 'today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === localDay(yesterday)) return 'yesterday'
  return day
}

/** A string field off an untyped payload, or null. Payloads are `Json` and every optional member
 *  on them is genuinely optional (a row written before the field existed carries none). */
function stringAt(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * How far back either source is read. A conversation is not an audit log: two hundred bubbles is
 * already more than anybody scrolls, and the whole history is one click away in Activity.
 *
 * ONE number for both, and it is a budget rather than a guarantee: the two sources are counted
 * separately, so a project with a thousand events and a dozen messages shows every message and
 * only the newest two hundred events. That is the right way round -- the messages ARE the
 * conversation, and the events are the context around them.
 */
const WINDOW = 200

/** One chat row as a bubble (F R1). A human row is the operator's, a supervisor row the
 *  Supervisor's -- there is no third speaker in this table. */
function chatMessage(view: SupervisorMessageView): SupervisorMessage {
  const actions = (view.actions ?? []).map((one) => ({
    decisionId: one.decisionId,
    tier: one.tier,
    kind: one.action.kind,
  }))
  return {
    // Prefixed, because the event rows are keyed by `seq` and a bare uuid beside a bare `12`
    // would be two id spaces sharing one field. `messageId` below carries the row's own id for
    // anything that has to name the ROW rather than the bubble.
    id: `msg:${view.id}`,
    messageId: view.id,
    who: view.role === 'human' ? 'operator' : 'supervisor',
    text: view.text,
    at: view.createdAt,
    // A chat row's chips are its ATTACHMENTS, which have their own field -- `refs` is the goal
    // version and the task id an EVENT carries, and there is no such thing on a message.
    refs: [],
    // The first action's decision, so the card the panel already matches by this field lands
    // under the reply that asked for it. A reply that asked for several carries them all on
    // `actions`, which is what a panel showing more than one card reads.
    decisionId: actions[0]?.decisionId ?? null,
    status: view.status,
    attachments: view.attachments,
    ...(view.actions === null ? {} : { actions }),
    costUsd: view.modelCostUsd,
    sourced: view.sourced,
    failureReason: view.failureReason,
  }
}

/**
 * The Supervisor panel's conversation history — the conversation's own rows, merged with the six
 * event families that surround them.
 *
 * M57 R9 read events ALONE, because there was no conversation table; F R1 added one and this is
 * where the two meet. A thread is still a LOCAL CALENDAR DAY, which is the one grouping a person
 * can predict without being told, and both sources are bucketed by the same clock and interleaved
 * by TIME inside a bucket — so a decision still appears beside the message that caused it.
 *
 * NOTHING IS DEDUPLICATED. A `workspace.goal_set` whose `request` is word for word a chat message
 * sent a few seconds earlier renders as two bubbles, deliberately: this projection cannot know
 * that one CAUSED the other (nothing on either row says so), and a guess that folded them would
 * silently drop a message somebody really sent. Hiding the echo is a panel's choice to make, with
 * `messageId` there to tell the two apart.
 *
 * `feedSummary` is the same projection the Activity river and the Overview's live-events panel
 * read, so a supervisor message says here exactly what it says there. The raw dotted type itself
 * is used only to pick `who`/`text` below and is not carried onto `SupervisorMessage` -- a bubble
 * has no `data-event-type` of its own, and `docs/ia.md` rule 3 is satisfied here by never printing
 * the bare type as a WORD, the same guarantee `feedSummary` gives every other reader of it.
 *
 * Newest thread first, oldest message first inside a thread — the order a person reads a list of
 * conversations in, and the order they read one.
 */
export async function buildSupervisorThreads(
  workspaceId: string,
  now: Date = new Date(),
): Promise<readonly SupervisorThread[]> {
  const [rows, chat] = await Promise.all([
    prisma.executionEvent.findMany({
      where: { workspaceId, type: { in: THREAD_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
      // The MOST RECENT {@link WINDOW}, read newest-first and turned back the right way round
      // below. Ascending here would have taken the OLDEST two hundred and left a busy project's
      // panel permanently showing its first week.
      orderBy: { seq: 'desc' },
      take: WINDOW,
    }),
    // The verb's own window, which is the newest `WINDOW` by `seq` handed back oldest first.
    listSupervisorMessages(workspaceId, { limit: WINDOW }),
  ])

  // ONE list, sorted by time, and only then bucketed: the two sources have no shared ordering
  // column -- a `seq` on an event and a `seq` on a message count different things -- so the clock
  // is the only thing they can be interleaved by.
  //
  // Two tiebreaks, in order, because a millisecond is not fine enough for either source. `rank`
  // first: a chat row wins against an event stamped the same millisecond, because a message is
  // what CAUSES the events around it. Then `seq` WITHIN one source -- a question and the reply
  // placeholder written in the same transaction share a `createdAt` to the millisecond, and a
  // thread that showed the reply above the question would be wrong in the one place a reader
  // would notice. The two spaces are never compared against each other: `rank` differs on every
  // cross-source pair, so the `seq` term is only ever reached between two rows of one kind.
  const timeline: { readonly at: number; readonly rank: 0 | 1; readonly seq: number; readonly message: SupervisorMessage }[] = [
    ...chat.map((view) => ({
      at: new Date(view.createdAt).getTime(),
      rank: 0 as const,
      seq: view.seq,
      message: chatMessage(view),
    })),
  ]

  for (const row of rows.reverse()) {
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    // A goal set that carries the words somebody TYPED is that person's message; one without is
    // the system saying a goal changed. Folding the two together would put the model's composed
    // document in a bubble attributed to a human.
    const request = domainType === 'workspace.goal_set' ? stringAt(payload, 'request') : null
    const refs: string[] = []
    const version = payload['version']
    if (typeof version === 'number') refs.push(`v${String(version)}`)
    const subjectId = stringAt(payload, 'subjectId')
    if (subjectId !== null) refs.push(subjectId)

    timeline.push({
      at: row.ts.getTime(),
      rank: 1,
      seq: Number(row.seq),
      message: {
        id: String(row.seq),
        who: request === null ? 'supervisor' : 'operator',
        text: request ?? feedSummary(domainType, payload),
        at: row.ts.toISOString(),
        refs: refs.slice(0, 2),
        decisionId: stringAt(payload, 'decisionId'),
      },
    })
  }

  timeline.sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq)

  const byDay = new Map<string, SupervisorMessage[]>()
  for (const entry of timeline) {
    const day = localDay(new Date(entry.at))
    const bucket = byDay.get(day)
    if (bucket === undefined) byDay.set(day, [entry.message])
    else bucket.push(entry.message)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, messages]) => ({
      id: day,
      // The first thing SAID that day, truncated -- a conversation's name is its opening line, the
      // way a mail thread's is its subject. The first row with words rather than the first row
      // full stop: a reply placeholder and a failed turn both carry an empty text (F R2), and a
      // day that opened with one would otherwise be a thread with no name at all.
      title: (messages.find((message) => message.text !== '')?.text ?? 'Conversation').slice(0, 60),
      when: whenLabel(day, now),
      messages,
    }))
}
