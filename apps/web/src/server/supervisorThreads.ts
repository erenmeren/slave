import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { feedSummary } from '../lib/feedSummary'

/** One bubble in the panel. `who` decides which side it is drawn on and which shape its corners
 *  take (README "Supervisor panel"); `decisionId` is how a card is matched onto the message it
 *  belongs inside, from the pending-decisions read the page already makes. */
export interface SupervisorMessage {
  readonly id: string
  readonly who: 'operator' | 'supervisor'
  readonly text: string
  /** ISO. */
  readonly at: string
  /** The small mono chips under a message — a goal version, a task id. Never more than two. */
  readonly refs: readonly string[]
  readonly decisionId: string | null
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
 *  formatted in, so a message can never fall in a thread dated differently from its own clock. */
function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

function whenLabel(day: string, now: Date): string {
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
 * The Supervisor panel's conversation history — a GROUPING over rows that already exist.
 *
 * There is no conversation table and this milestone refuses to add one (M57 R9): a thread is a
 * LOCAL CALENDAR DAY, which is the one grouping the data can actually support and the one a person
 * can predict without being told. The `+` button in the panel starts a thread for today and writes
 * nothing — there is no row to create; it is a scroll position and an empty composer.
 *
 * `feedSummary` is the same projection the Activity river and the Overview's live-events panel
 * read, so a supervisor message says here exactly what it says there (`docs/ia.md` rule 3: the raw
 * dotted type stays available, and the panel puts it on each bubble's `data-event-type`).
 *
 * Newest thread first, oldest message first inside a thread — the order a person reads a list of
 * conversations in, and the order they read one.
 */
export async function buildSupervisorThreads(
  workspaceId: string,
  now: Date = new Date(),
): Promise<readonly SupervisorThread[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: { in: THREAD_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
    // The MOST RECENT 200, read newest-first and turned back the right way round below. A
    // conversation is not an audit log: two hundred bubbles is already more than anybody scrolls,
    // and the whole history is one click away in Activity. Ascending here would have taken the
    // OLDEST two hundred and left a busy project's panel permanently showing its first week.
    orderBy: { seq: 'desc' },
    take: 200,
  })

  const byDay = new Map<string, SupervisorMessage[]>()
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

    const day = localDay(row.ts)
    const message: SupervisorMessage = {
      id: String(row.seq),
      who: request === null ? 'supervisor' : 'operator',
      text: request ?? feedSummary(domainType, payload),
      at: row.ts.toISOString(),
      refs: refs.slice(0, 2),
      decisionId: stringAt(payload, 'decisionId'),
    }
    const bucket = byDay.get(day)
    if (bucket === undefined) byDay.set(day, [message])
    else bucket.push(message)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, messages]) => ({
      id: day,
      // The first thing said that day, truncated -- a conversation's name is its opening line, the
      // way a mail thread's is its subject.
      title: (messages[0]?.text ?? 'Conversation').slice(0, 60),
      when: whenLabel(day, now),
      messages,
    }))
}
