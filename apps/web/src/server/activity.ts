import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { feedSummary } from '../lib/feedSummary'
import { buildShellFacts, type ShellFacts } from './shell'
import { EMPTY_ACTIVITY_FILTERS, type ActivityFilters } from '../lib/activityFilters'

export interface ActivityEventRow {
  readonly seq: number
  readonly ts: string
  readonly type: DomainEventType
  readonly actor: string
  readonly slaveId: string | null
  readonly taskId: string | null
  readonly runId: string | null
  /** M23 F6: who caused this event, or null -- the CLI/orchestrator write no user, and every
   *  event from before this column existed reads back null too. */
  readonly userId: string | null
  readonly payload: Record<string, unknown>
  readonly summary: string
}

export interface ActivityHistoryPage {
  readonly events: readonly ActivityEventRow[]
  readonly nextBefore: number | null
  /** The workspace-wide tool-call sparkline (spec §4.2/§4.5: "the workspace's tool-call rate"),
   *  carried on every history page — not just the unfiltered `ActivityPage` — regardless of the
   *  filters that shaped `events`. The client re-seeds its live sparkline from this field on
   *  every mount and filter switch (review finding 3): the sparkline stays workspace-scoped, so
   *  the *only* thing that can drift it back to true is a fresh read from here. */
  readonly sparkline: readonly number[]
}

export interface ActivityPage extends ActivityHistoryPage {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  /** The workspace's slave/task rosters, `{id, name|title}[]` only — everything the page needs
   *  for the FilterBar's two multi-selects and for resolving a card's `slaveName`/`taskTitle`
   *  from an event's bare `slaveId`/`taskId`. Two lightweight selects (no `include`, no run/task
   *  rows) alongside the existing history + sparkline queries, so the page still costs one server
   *  round-trip; deliberately not a third snapshot builder (`buildOverviewSnapshot` and
   *  `buildTasksSnapshot` already own the *full* slave/task shapes their own pages need). */
  readonly slaves: readonly { readonly id: string; readonly name: string }[]
  readonly tasks: readonly { readonly id: string; readonly title: string }[]
  /** Every local account (M23 F6), for resolving an event's bare `userId` to a username the same
   *  way `slaves`/`tasks` resolve `slaveId`/`taskId`. The whole table, unfiltered -- there is no
   *  per-workspace scoping for a `User` row, and this table is small (bound assumption: an
   *  operator's local accounts, not a multi-tenant user base). */
  readonly users: readonly { readonly id: string; readonly username: string }[]
  /** Event counts by kind prefix over the last 24 hours, for the right rail's volume bars.
   *  Sorted by count descending; a kind with no events in the window is omitted, never shown as
   *  a zero bar. */
  readonly typeVolumes: readonly { readonly prefix: string; readonly count: number }[]
  /**
   * The same counts/guardrails the project header and the Tasks tab's badge show (M14 Task 3/8/12
   * controller ruling; M24 Task 2 moved them off the global shell's `<Sidebar>` onto the project
   * header/tabs): this route already streams the workspace `/w/:id/activity` mounts, so
   * `ActivityClient` publishes this to `hooks/useShellFacts.ts` on every snapshot rather than the
   * header/tabs opening a second connection against `/api/w/:id/shell` for the same workspace.
   * The same member `TasksSnapshot` and `GraphView` already carry, for the same reason.
   */
  readonly shellFacts: ShellFacts
}

/**
 * 24-hour volumes by KIND PREFIX (`run.*`, `task.*`, ...) -- the dotted domain name's first
 * segment, not the six user-facing `ActivityKind` buckets: the rail answers "what has this
 * system been doing", and the chips above it already answer "what do I want to see".
 *
 * The window is a SQL `interval` LITERAL rather than a bound parameter, for the same reason
 * `toolCallSparkline`'s own `interval '10 minutes'` is one: Postgres infers no type for a
 * placeholder in that position.
 *
 * Raw SQL for the same reason `toolCallSparkline` uses it: Prisma has no `groupBy` over a derived
 * expression. The DB enum's stored values are dotted (`run.tool_call`), so `split_part` on the
 * cast text is the prefix; the Prisma-mapped member name (`run_tool_call`) is a TypeScript-only
 * alias that does not exist in Postgres.
 */
export async function eventTypeVolumes(
  workspaceId: string,
): Promise<readonly { readonly prefix: string; readonly count: number }[]> {
  // `ORDER BY 2 DESC, 1 ASC`: count first (the rail is read widest-first), then the prefix
  // itself, so two equally busy kinds always come back in the same order rather than in whatever
  // order the scan happened to produce.
  const rows = await prisma.$queryRaw<Array<{ prefix: string; n: bigint }>>`
    SELECT split_part(type::text, '.', 1) || '.*' AS prefix, count(*) AS n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND ts >= now() - interval '24 hours'
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC`
  return rows.map((row) => ({ prefix: row.prefix, count: Number(row.n) }))
}

export const ACTIVITY_PAGE_LIMIT_DEFAULT = 100
export const ACTIVITY_PAGE_LIMIT_MAX = 200

/** One bucket per minute over the sparkline's trailing window. */
const SPARKLINE_MINUTES = 10

/**
 * Zero-filled, oldest-minute-first bucketing of grouped `(minute, count)` rows into the trailing
 * `SPARKLINE_MINUTES` one-minute buckets, keyed by how many whole minutes before `now` each row's
 * minute falls. A row whose minute falls outside the window is dropped rather than throwing — the
 * SQL `ts >=` filter already keeps this defensive only.
 */
export function bucketSparkline(
  rows: readonly { readonly minute: Date; readonly n: bigint | number }[],
  now: Date = new Date(),
): number[] {
  const buckets = new Array(SPARKLINE_MINUTES).fill(0) as number[]
  const nowMinute = Math.floor(now.getTime() / 60_000)
  for (const row of rows) {
    const minutesAgo = nowMinute - Math.floor(row.minute.getTime() / 60_000)
    if (minutesAgo >= 0 && minutesAgo < SPARKLINE_MINUTES) {
      const index = SPARKLINE_MINUTES - 1 - minutesAgo
      buckets[index] = (buckets[index] ?? 0) + Number(row.n)
    }
  }
  return buckets
}

/**
 * Workspace-wide `run.tool_call` counts for the last `SPARKLINE_MINUTES` minutes, one grouped
 * query. The DB enum's stored values are dotted (`EventType` members `@map` to `"run.tool_call"`
 * etc. — confirmed against the schema and `\dT+ "EventType"` on the test database), so the raw-SQL
 * literal below must be dotted too; the Prisma-mapped member name (`run_tool_call`) is a
 * TypeScript-only alias that does not exist in Postgres.
 *
 * The window predicate and `bucketSparkline` share the single `now` passed in (or defaulted here)
 * rather than each taking its own reading, so a minute boundary crossed between the two can't shift
 * the SQL window and the bucket index against each other.
 */
export async function toolCallSparkline(workspaceId: string, now: Date = new Date()): Promise<readonly number[]> {
  // The ::timestamp cast on `now` below is load-bearing, not decorative: a bare `${now}` bound
  // parameter next to an `interval` literal leaves Postgres unable to infer the parameter's type
  // and it raises 42883 ("operator does not exist: timestamp without time zone >= interval"). The
  // cast matches the column's own timestamp(3) type (`ExecutionEvent.ts`'s undecorated
  // `DateTime @default(now())`), so it does not shift the value -- and both sides of the comparison
  // stay timezone-naive, which is what keeps it timezone-safe (see the flake ledger's Flake 5 for
  // the empirical trace of the failure this cast prevents).
  const rows = await prisma.$queryRaw<Array<{ minute: Date; n: bigint }>>`
    SELECT date_trunc('minute', ts) as minute, count(*) as n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND type = 'run.tool_call'::"EventType"
      AND ts >= ${now}::timestamp - interval '10 minutes'
    GROUP BY 1`
  return bucketSparkline(rows, now)
}

/**
 * Pages the workspace's execution event log newest-first for the activity timeline. Reads only —
 * every write to `ExecutionEvent` goes through `appendEvent` (`@slave-of-ai/events`), never here.
 *
 * `before` is an exclusive `seq` cursor (`seq < before`); `nextBefore` is the oldest `seq` in the
 * page just returned, or `null` once a page comes back shorter than requested — the log is
 * exhausted, not just this page's slice of it.
 */
export async function buildActivityHistory(
  workspaceId: string,
  filters: ActivityFilters,
  options?: { readonly before?: number; readonly limit?: number },
  now: Date = new Date(),
): Promise<ActivityHistoryPage | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const take = Math.min(options?.limit ?? ACTIVITY_PAGE_LIMIT_DEFAULT, ACTIVITY_PAGE_LIMIT_MAX)

  // The sparkline is workspace-wide (never filtered — see `ActivityHistoryPage.sparkline`), so
  // it runs alongside the paged `findMany` rather than depending on its result; one extra grouped
  // query per history page, same cost the unfiltered `buildActivityPage` already paid before this
  // page carried its own sparkline too.
  const [rows, sparkline] = await Promise.all([
    prisma.executionEvent.findMany({
      where: {
        workspaceId,
        ...(filters.slaves.length > 0 ? { slaveId: { in: [...filters.slaves] } } : {}),
        ...(filters.tasks.length > 0 ? { taskId: { in: [...filters.tasks] } } : {}),
        ...(filters.types.length > 0
          ? { type: { in: filters.types.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } }
          : {}),
        ...(options?.before !== undefined ? { seq: { lt: options.before } } : {}),
      },
      orderBy: { seq: 'desc' },
      take,
    }),
    toolCallSparkline(workspaceId, now),
  ])

  const events: ActivityEventRow[] = rows.map((row) => {
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    return {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      actor: row.actor,
      slaveId: row.slaveId,
      taskId: row.taskId,
      runId: row.runId,
      userId: row.userId,
      payload,
      summary: feedSummary(domainType, payload),
    }
  })

  const lastRow = events.at(-1)
  const nextBefore = events.length < take || lastRow === undefined ? null : lastRow.seq

  return { events, nextBefore, sparkline }
}

/**
 * The activity page's initial load: workspace identity, the unfiltered first history page (which
 * now carries its own workspace-wide sparkline — see `buildActivityHistory`), and the workspace's
 * slave/task rosters. Composed from `buildActivityHistory` rather than a duplicate sparkline query.
 */
export async function buildActivityPage(workspaceId: string): Promise<ActivityPage | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const [history, slaves, tasks, users, typeVolumes, shellFacts] = await Promise.all([
    buildActivityHistory(workspaceId, EMPTY_ACTIVITY_FILTERS, {}),
    prisma.slave.findMany({ where: { team: { workspaceId } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.task.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
    prisma.user.findMany({ select: { id: true, username: true }, orderBy: { username: 'asc' } }),
    eventTypeVolumes(workspaceId),
    buildShellFacts(workspaceId),
  ])

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    // `history` cannot be null here: the same workspace lookup above already confirmed it exists.
    events: history!.events,
    nextBefore: history!.nextBefore,
    sparkline: history!.sparkline,
    slaves,
    tasks,
    users,
    typeVolumes,
    // Same reasoning as `history!`: `buildShellFacts` only returns null for a workspace that does
    // not exist, which the lookup at the top of this function has already ruled out.
    shellFacts: shellFacts!,
  }
}
