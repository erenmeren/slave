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
 * - Token counts left with the per-slave table (M53 R12). They were CLAUDE-ONLY -- Cursor reports
 *   none -- and no tile on this page has ever shown them.
 * - There is NO money on this page since M53 R6. The `Spend` tile's figure was a raw
 *   `SUM(costUsd)` over every run in scope -- no provenance, no profile, no model, no domain -- so
 *   it presented the measured part of a bill as the whole of it. Money is three figures with three
 *   words beside them on `/workforce?tab=evidence`, where the provenance each run was recorded with
 *   is a column rather than a rounding error.
 * - The five KPI tiles are computed over ALL of this scope's runs, not just the 7-day window the
 *   series and the seeded caption describe -- an average duration or a success rate over the last
 *   week alone would swing wildly on a quiet workspace, and the day-by-day trend already exists for
 *   the windowed view. Only `series` is window-bound.
 * - The per-slave performance table is GONE (M53 R12): it counted one project's materialised
 *   workers, which is neither a profile nor a model, and its questions are answered per profile and
 *   per model on `/workforce?tab=evidence` -- `docs/ia.md` rule 2, nothing removed, only moved.
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

export interface AnalyticsSnapshot {
  /** `null` for the global (all-workspace) view. */
  readonly workspaceId: string | null
  /** `true` only when `workspaceId` is the fixed id `db:seed` writes (spec Decision 3) — never
   *  true for the all-workspaces view, even when that seeded workspace exists among others. Feeds
   *  the page's "Last 7 days · seeded development data" caption. */
  readonly seeded: boolean
  readonly series: readonly DayCount[]
  /** Exactly five, in the order the page renders them (M53 R12 / plan erratum E18 -- `Spend` left
   *  with the raw `SUM(costUsd)` behind it). The same five render on the Projects home, from this
   *  same builder with a null scope. */
  readonly kpis: readonly Kpi[]
}

/** The three figures the five remaining tiles need, in ONE row (M53 R12).
 *
 *  This was `perSlaveRunAggregates`: one row per slave, with a `SUM(r."costUsd")` and an unmeasured
 *  count beside it that fed the `Spend` tile and the per-slave table. Both are gone, and what is
 *  left is three totals over the same scope -- so the query is no longer grouped at all and always
 *  answers exactly one row. `bigint` on the COUNT/SUM-of-integer columns is `pg`'s driver behaviour
 *  for those aggregates; the caller converts with `Number()` at the point it reads the field.
 *
 *  Raw SQL rather than `prisma.slaveRun.aggregate`: the duration sum is
 *  `SUM(EXTRACT(EPOCH FROM (endedAt - startedAt)))` under a `FILTER`, which has no Prisma
 *  expression, and the negative-span guard has to live in the same place as the count that pairs
 *  with it or the mean is computed over a different set than it was summed over. */
interface RunTotalsRow {
  readonly durationMsSum: number | null
  readonly durationCount: bigint
  readonly toolCalls: bigint | null
}

async function runTotals(workspaceId: string | null): Promise<RunTotalsRow> {
  const scopeJoin =
    workspaceId === null
      ? Prisma.empty
      : Prisma.sql`JOIN "Slave" a ON a."id" = r."slaveId" JOIN "Team" t ON t."id" = a."teamId" WHERE t."workspaceId" = ${workspaceId}`
  const rows = await prisma.$queryRaw<RunTotalsRow[]>(Prisma.sql`
    SELECT
      (SUM(EXTRACT(EPOCH FROM (r."endedAt" - r."startedAt")) * 1000)
        FILTER (WHERE r."terminalAt" IS NOT NULL AND r."endedAt" IS NOT NULL AND r."endedAt" >= r."startedAt"))::float8 AS "durationMsSum",
      COUNT(*) FILTER (WHERE r."terminalAt" IS NOT NULL AND r."endedAt" IS NOT NULL AND r."endedAt" >= r."startedAt") AS "durationCount",
      SUM(r."toolCalls") AS "toolCalls"
    FROM "SlaveRun" r
    ${scopeJoin}`)
  // An aggregate with no GROUP BY always answers one row, even over no rows at all -- the fallback
  // is for the type, not for a case this query can reach.
  return rows[0] ?? { durationMsSum: null, durationCount: 0n, toolCalls: null }
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
  const runWhere = workspaceId === null ? {} : { slave: { team: { workspaceId } } }
  const from = windowStart()

  const [windowRuns, totals, pauses, activeSlaveRows, tasks] = await Promise.all([
    prisma.slaveRun.findMany({
      where: { ...runWhere, terminalAt: { gte: from } },
      select: { status: true, terminalAt: true },
    }),
    runTotals(workspaceId),
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

  // ---- the five KPIs ---------------------------------------------------------------------
  const countOf = (statuses: readonly string[]): number =>
    tasks.filter((t) => statuses.includes(t.status)).reduce((n, t) => n + t._count._all, 0)
  const done = countOf(['done'])
  const failedTasks = countOf(['failed'])
  const successDenominator = done + failedTasks

  // One row, three figures — the loop that used to fold one row per slave into these went with the
  // table it fed (M53 R12). `?? 0` on each: a `SUM` over no rows is SQL's null, and a total of
  // nothing is a measured zero here rather than a gap, because the denominators beside them are
  // counts that are zero too.
  const durationMsSum = totals.durationMsSum ?? 0
  const durationCount = Number(totals.durationCount)
  const toolCallsTotal = Number(totals.toolCalls ?? 0n)

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
    // No `Spend` tile since M53 R6 (plan erratum E18): its figure was a raw `SUM(costUsd)` with no
    // provenance in it, and money now lives on `/workforce?tab=evidence` as three figures with
    // three words beside them -- reported, estimated, and the count nobody measured.
    { label: 'Tool calls', value: String(toolCallsTotal), note: null },
    { label: 'Pauses', value: String(pauses), note: null },
    { label: 'Active slaves', value: String(activeSlaveRows.length), note: null },
  ]

  return { workspaceId, seeded: workspaceId === SEED_WORKSPACE_ID, series, kpis }
}
