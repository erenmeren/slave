import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@ai-team-os/db'
import { feedSummary } from '../lib/feedSummary'
import { EMPTY_ACTIVITY_FILTERS, type ActivityFilters } from '../lib/activityFilters'

export interface ActivityEventRow {
  readonly seq: number
  readonly ts: string
  readonly type: DomainEventType
  readonly actor: string
  readonly agentId: string | null
  readonly taskId: string | null
  readonly runId: string | null
  readonly payload: Record<string, unknown>
  readonly summary: string
}

export interface ActivityHistoryPage {
  readonly events: readonly ActivityEventRow[]
  readonly nextBefore: number | null
}

export interface ActivityPage extends ActivityHistoryPage {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly sparkline: readonly number[]
  /** The workspace's agent/task rosters, `{id, name|title}[]` only — everything the page needs
   *  for the FilterBar's two multi-selects and for resolving a card's `agentName`/`taskTitle`
   *  from an event's bare `agentId`/`taskId`. Two lightweight selects (no `include`, no run/task
   *  rows) alongside the existing history + sparkline queries, so the page still costs one server
   *  round-trip; deliberately not a third snapshot builder (`buildOverviewSnapshot` and
   *  `buildTasksSnapshot` already own the *full* agent/task shapes their own pages need). */
  readonly agents: readonly { readonly id: string; readonly name: string }[]
  readonly tasks: readonly { readonly id: string; readonly title: string }[]
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
 */
export async function toolCallSparkline(workspaceId: string): Promise<readonly number[]> {
  const now = new Date()
  const rows = await prisma.$queryRaw<Array<{ minute: Date; n: bigint }>>`
    SELECT date_trunc('minute', ts) as minute, count(*) as n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND type = 'run.tool_call'::"EventType"
      AND ts >= now() - interval '10 minutes'
    GROUP BY 1`
  return bucketSparkline(rows, now)
}

/**
 * Pages the workspace's execution event log newest-first for the activity timeline. Reads only —
 * every write to `ExecutionEvent` goes through `appendEvent` (`@ai-team-os/events`), never here.
 *
 * `before` is an exclusive `seq` cursor (`seq < before`); `nextBefore` is the oldest `seq` in the
 * page just returned, or `null` once a page comes back shorter than requested — the log is
 * exhausted, not just this page's slice of it.
 */
export async function buildActivityHistory(
  workspaceId: string,
  filters: ActivityFilters,
  options?: { readonly before?: number; readonly limit?: number },
): Promise<ActivityHistoryPage | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const take = Math.min(options?.limit ?? ACTIVITY_PAGE_LIMIT_DEFAULT, ACTIVITY_PAGE_LIMIT_MAX)

  const rows = await prisma.executionEvent.findMany({
    where: {
      workspaceId,
      ...(filters.agents.length > 0 ? { agentId: { in: [...filters.agents] } } : {}),
      ...(filters.tasks.length > 0 ? { taskId: { in: [...filters.tasks] } } : {}),
      ...(filters.types.length > 0
        ? { type: { in: filters.types.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } }
        : {}),
      ...(options?.before !== undefined ? { seq: { lt: options.before } } : {}),
    },
    orderBy: { seq: 'desc' },
    take,
  })

  const events: ActivityEventRow[] = rows.map((row) => {
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    return {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      actor: row.actor,
      agentId: row.agentId,
      taskId: row.taskId,
      runId: row.runId,
      payload,
      summary: feedSummary(domainType, payload),
    }
  })

  const lastRow = events.at(-1)
  const nextBefore = events.length < take || lastRow === undefined ? null : lastRow.seq

  return { events, nextBefore }
}

/**
 * The activity page's initial load: workspace identity, the unfiltered first history page, and
 * the workspace-wide tool-call sparkline — composed from `buildActivityHistory` and
 * `toolCallSparkline` (one grouped query each) rather than a third query.
 */
export async function buildActivityPage(workspaceId: string): Promise<ActivityPage | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const [history, sparkline, agents, tasks] = await Promise.all([
    buildActivityHistory(workspaceId, EMPTY_ACTIVITY_FILTERS, {}),
    toolCallSparkline(workspaceId),
    prisma.agent.findMany({ where: { team: { workspaceId } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.task.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
  ])

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    // `history` cannot be null here: the same workspace lookup above already confirmed it exists.
    events: history!.events,
    nextBefore: history!.nextBefore,
    sparkline,
    agents,
    tasks,
  }
}
