import { Prisma, prisma } from '@slave-of-ai/db/client'
import { SEED_WORKSPACE_ID } from '@slave-of-ai/db'
import { NON_TERMINAL_RUN_STATUSES } from '@slave-of-ai/domain'
import { formatDuration } from '../lib/format'

/**
 * The Analytics page's aggregation (M14 §4.4): one query round per section, all scoped to a
 * workspace, or to every workspace when `workspaceId` is `null` (the global `/analytics` route).
 *
 * **Stated limits, because the page shows figures an operator will act on:**
 * - Skill counts are END-OF-RUN facts (`SlaveRun.skillCalls`, M14 §4.1). A run in flight
 *   contributes nothing, so "skills used today" trails the live board by one run.
 * - Token counts are CLAUDE-ONLY. Cursor reports none, and `tokens` is `null` for a slave whose
 *   runs are all on Cursor — not zero.
 * - Cost is KNOWN cost. `unmeasuredRuns` beside it is how many runs really ran, finished, and
 *   left no figure; it is never folded into the total.
 * - The KPI tiles and per-slave table are computed over ALL of this scope's runs, not just the
 *   7-day window the series and the seeded caption describe -- an average duration or a success
 *   rate over the last week alone would swing wildly on a quiet workspace, and the day-by-day
 *   trend already exists for the windowed view. Only `series` is window-bound.
 */
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. Seven entries, oldest first, zero-filled. */
  readonly day: string
  readonly succeeded: number
  readonly failed: number
}

export interface Kpi {
  readonly label: string
  /** Already formatted for display (`'92%'`, `'14m 20s'`, `'$8.43'`, `'—'`). The page renders it
   *  verbatim; formatting lives here so the seven-day chart and the tiles cannot disagree. */
  readonly value: string
  /** A second line under the figure, or `null`. Carries the unmeasured count where there is one
   *  (`'3 runs unmeasured'`) — never folded into `value`. */
  readonly note: string | null
}

export interface SlavePerformanceRow {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly runs: number
  /** `null` when the slave has no terminal run at all — no denominator, no rate. */
  readonly successPct: number | null
  /** Mean `endedAt − startedAt` in ms over terminal runs, `null` with none. */
  readonly avgDurationMs: number | null
  /** Summed `tokensIn + tokensOut` over runs that reported them, `null` when none did. */
  readonly tokens: number | null
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

export interface AnalyticsSnapshot {
  /** `null` for the global (all-workspace) view. */
  readonly workspaceId: string | null
  /** `true` only when `workspaceId` is the fixed id `db:seed` writes (spec Decision 3) — never
   *  true for the all-workspaces view, even when that seeded workspace exists among others. Feeds
   *  the page's "Last 7 days · seeded development data" caption. */
  readonly seeded: boolean
  readonly series: readonly DayCount[]
  /** Exactly six, in the order the page renders them. */
  readonly kpis: readonly Kpi[]
  readonly perSlave: readonly SlavePerformanceRow[]
}

/** One row per slave that has ever run, from `perSlaveRunAggregates` — every JS reduce the old
 *  `allRuns` + per-slave pass used to do, expressed as a SQL `FILTER` instead. `bigint` on the
 *  COUNT/SUM-of-integer columns is `pg`'s driver behaviour for those aggregates; every consumer
 *  converts with `Number()` at the point it reads the field, never earlier. */
interface SlaveAggRow {
  readonly slaveId: string
  readonly terminal: bigint
  readonly succeeded: bigint
  readonly durationMsSum: number | null
  readonly durationCount: bigint
  readonly reported: bigint
  readonly tokensSum: bigint | null
  readonly knownUsd: number | null
  readonly unmeasured: bigint
  readonly toolCalls: bigint
}

/**
 * One row per slave that has ever run in this scope, grouped in SQL rather than fetched as
 * `SlaveRun` rows and reduced in JS (Task 12, M17): the old `allRuns` findMany pulled every run in
 * the database on the global (`workspaceId: null`) route. Every branch below is the same rule the
 * old JS reduce applied, restated as a `FILTER` clause — see `apps/web/test/integration/
 * analytics-aggregates.test.ts` for the equivalence proof against that old computation.
 */
export async function perSlaveRunAggregates(workspaceId: string | null): Promise<readonly SlaveAggRow[]> {
  const scopeJoin =
    workspaceId === null
      ? Prisma.empty
      : Prisma.sql`JOIN "Slave" a ON a."id" = r."slaveId" JOIN "Team" t ON t."id" = a."teamId" WHERE t."workspaceId" = ${workspaceId}`
  return prisma.$queryRaw<SlaveAggRow[]>(Prisma.sql`
    SELECT r."slaveId" AS "slaveId",
      COUNT(*) FILTER (WHERE r."terminalAt" IS NOT NULL) AS terminal,
      COUNT(*) FILTER (WHERE r."terminalAt" IS NOT NULL AND r."status"::text = 'succeeded') AS succeeded,
      (SUM(EXTRACT(EPOCH FROM (r."endedAt" - r."startedAt")) * 1000)
        FILTER (WHERE r."terminalAt" IS NOT NULL AND r."endedAt" IS NOT NULL AND r."endedAt" >= r."startedAt"))::float8 AS "durationMsSum",
      COUNT(*) FILTER (WHERE r."terminalAt" IS NOT NULL AND r."endedAt" IS NOT NULL AND r."endedAt" >= r."startedAt") AS "durationCount",
      COUNT(*) FILTER (WHERE r."tokensIn" IS NOT NULL OR r."tokensOut" IS NOT NULL) AS reported,
      SUM(COALESCE(r."tokensIn", 0) + COALESCE(r."tokensOut", 0))
        FILTER (WHERE r."tokensIn" IS NOT NULL OR r."tokensOut" IS NOT NULL) AS "tokensSum",
      SUM(r."costUsd")::float8 AS "knownUsd",
      COUNT(*) FILTER (WHERE r."costUsd" IS NULL AND r."provider" IS NOT NULL
        AND r."status"::text NOT IN (${Prisma.join([...NON_TERMINAL_RUN_STATUSES])})) AS unmeasured,
      SUM(r."toolCalls") AS "toolCalls"
    FROM "SlaveRun" r
    ${scopeJoin}
    GROUP BY r."slaveId"`)
}

const WINDOW_DAYS = 7

/** `YYYY-MM-DD` in UTC. The day boundary is UTC everywhere in this module — a local boundary would
 *  make the same run land in different buckets for two operators. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function windowStart(): Date {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1))
  return start
}

// `formatDuration` moved to `../lib/format.ts` (Task 16): this module value-imports
// `@slave-of-ai/db/client` at the top, so a client component that imported the function straight
// from here would drag `pg`'s Node-only dependencies into the browser bundle. Re-exported below
// so this module's own KPI computation (and any other server-side caller) still finds it here.
export { formatDuration } from '../lib/format'

export async function buildAnalytics(workspaceId: string | null): Promise<AnalyticsSnapshot> {
  const slaveWhere = workspaceId === null ? {} : { team: { workspaceId } }
  const runWhere = workspaceId === null ? {} : { slave: { team: { workspaceId } } }
  const from = windowStart()

  const [slaves, windowRuns, aggRows, pauses, activeSlaveRows, tasks] = await Promise.all([
    prisma.slave.findMany({ where: slaveWhere, orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
    prisma.slaveRun.findMany({
      where: { ...runWhere, terminalAt: { gte: from } },
      select: { status: true, terminalAt: true },
    }),
    perSlaveRunAggregates(workspaceId),
    prisma.executionEvent.count({
      where: { type: 'run_paused', ...(workspaceId === null ? {} : { workspaceId }) },
    }),
    // Slaves, not runs: the scheduler enforces at most one non-terminal run per slave, but
    // this query does not lean on that invariant staying true -- it names its unit directly
    // (`distinct: ['slaveId']`) rather than counting rows and hoping they never double up, the
    // way `overview.ts`'s `liveRunBySlave` dedupes explicitly instead of trusting the same rule.
    prisma.slaveRun.findMany({
      where: { ...runWhere, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
      distinct: ['slaveId'],
      select: { slaveId: true },
    }),
    prisma.task.groupBy({
      by: ['status'],
      where: workspaceId === null ? {} : { workspaceId },
      _count: { _all: true },
    }),
  ])

  // ---- the 7-day series ------------------------------------------------------------------
  const byDay = new Map<string, { succeeded: number; failed: number }>()
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const day = new Date(from)
    day.setUTCDate(day.getUTCDate() + i)
    byDay.set(dayKey(day), { succeeded: 0, failed: 0 })
  }
  for (const run of windowRuns) {
    if (run.terminalAt === null) continue
    const bucket = byDay.get(dayKey(run.terminalAt))
    if (bucket === undefined) continue
    // `stopped` counts as neither: an operator's cancel is not the system failing, and colouring
    // it red would put the operator's own interventions on the failure line.
    if (run.status === 'succeeded') bucket.succeeded += 1
    else if (run.status === 'failed') bucket.failed += 1
  }
  const series: DayCount[] = [...byDay.entries()].map(([day, counts]) => ({ day, ...counts }))

  // ---- the six KPIs ----------------------------------------------------------------------
  const countOf = (statuses: readonly string[]): number =>
    tasks.filter((t) => statuses.includes(t.status)).reduce((n, t) => n + t._count._all, 0)
  const done = countOf(['done'])
  const failedTasks = countOf(['failed'])
  const successDenominator = done + failedTasks

  // Every ingredient below is a straight sum across `aggRows` (one row per slave) of the exact
  // figure the old per-slave `FILTER`-equivalent JS reduce produced for that slave — see
  // `perSlaveRunAggregates`'s doc comment and the equivalence test it points to.
  let durationMsSum = 0
  let durationCount = 0
  let knownUsd = 0
  let unknownRuns = 0
  let toolCallsTotal = 0
  for (const row of aggRows) {
    durationMsSum += row.durationMsSum ?? 0
    durationCount += Number(row.durationCount)
    knownUsd += row.knownUsd ?? 0
    unknownRuns += Number(row.unmeasured)
    toolCallsTotal += Number(row.toolCalls)
  }

  const kpis: readonly Kpi[] = [
    {
      label: 'Task success rate',
      value: successDenominator === 0 ? '—' : `${Math.round((done / successDenominator) * 100)}%`,
      note: successDenominator === 0 ? 'no task has finished yet' : `${done} of ${successDenominator}`,
    },
    {
      label: 'Avg run duration',
      value: durationCount === 0 ? '—' : formatDuration(durationMsSum / durationCount),
      note: durationCount === 0 ? null : `over ${durationCount} run(s)`,
    },
    {
      label: 'Spend',
      value: `$${knownUsd.toFixed(2)}`,
      // Its own line, never folded into the figure (Decision 4): a total that silently absorbs
      // unmeasured runs as zeros presents the measured part of a bill as the whole of it.
      note: unknownRuns === 0 ? null : `${unknownRuns} run${unknownRuns === 1 ? '' : 's'} unmeasured`,
    },
    { label: 'Tool calls', value: String(toolCallsTotal), note: null },
    { label: 'Pauses', value: String(pauses), note: null },
    { label: 'Active slaves', value: String(activeSlaveRows.length), note: null },
  ]

  // ---- per-slave performance -------------------------------------------------------------
  const aggBySlave = new Map(aggRows.map((row) => [row.slaveId, row]))

  const perSlave: readonly SlavePerformanceRow[] = slaves.map((slave) => {
    const agg = aggBySlave.get(slave.id)
    const terminal = agg === undefined ? 0 : Number(agg.terminal)

    return {
      slaveId: slave.id,
      name: slave.name,
      role: slave.role,
      runs: terminal,
      // `null` when the slave has no terminal run at all — no denominator, no rate.
      successPct: terminal === 0 || agg === undefined ? null : Math.round((Number(agg.succeeded) / terminal) * 100),
      // Mean `endedAt − startedAt` in ms over terminal runs, `null` with none.
      avgDurationMs:
        agg === undefined || Number(agg.durationCount) === 0 ? null : (agg.durationMsSum ?? 0) / Number(agg.durationCount),
      // `null` when NO run reported, a sum when some did (Decision 4). A partial sum is still a
      // real measurement of the runs that reported; a zero would be a claim about the ones that
      // did not.
      tokens: agg === undefined || Number(agg.reported) === 0 ? null : Number(agg.tokensSum ?? 0n),
      costUsd: agg?.knownUsd ?? 0,
      unmeasuredRuns: agg === undefined ? 0 : Number(agg.unmeasured),
    }
  })

  return { workspaceId, seeded: workspaceId === SEED_WORKSPACE_ID, series, kpis, perSlave }
}
