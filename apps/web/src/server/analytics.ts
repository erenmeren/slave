import { prisma } from '@ai-team-os/db/client'
import { SEED_WORKSPACE_ID } from '@ai-team-os/db'
import { sumSpend, NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

/**
 * The Analytics page's aggregation (M14 §4.4): one query round per section, all scoped to a
 * workspace, or to every workspace when `workspaceId` is `null` (the global `/analytics` route).
 *
 * **Stated limits, because the page shows figures an operator will act on:**
 * - Skill counts are END-OF-RUN facts (`AgentRun.skillCalls`, M14 §4.1). A run in flight
 *   contributes nothing, so "skills used today" trails the live board by one run.
 * - Token counts are CLAUDE-ONLY. Cursor reports none, and `tokens` is `null` for an agent whose
 *   runs are all on Cursor — not zero.
 * - Cost is KNOWN cost. `unmeasuredRuns` beside it is how many runs really ran, finished, and
 *   left no figure; it is never folded into the total.
 * - The KPI tiles and per-agent table are computed over ALL of this scope's runs, not just the
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

export interface AgentPerformanceRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly runs: number
  /** `null` when the agent has no terminal run at all — no denominator, no rate. */
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
  readonly perAgent: readonly AgentPerformanceRow[]
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

/** `860000` → `14m 20s`; `45000` → `45s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes === 0 ? `${rest}s` : `${minutes}m ${String(rest).padStart(2, '0')}s`
}

export async function buildAnalytics(workspaceId: string | null): Promise<AnalyticsSnapshot> {
  const agentWhere = workspaceId === null ? {} : { team: { workspaceId } }
  const runWhere = workspaceId === null ? {} : { agent: { team: { workspaceId } } }
  const from = windowStart()

  const [agents, windowRuns, allRuns, pauses, liveRuns, tasks] = await Promise.all([
    prisma.agent.findMany({ where: agentWhere, orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
    prisma.agentRun.findMany({
      where: { ...runWhere, terminalAt: { gte: from } },
      select: { status: true, terminalAt: true },
    }),
    prisma.agentRun.findMany({
      where: runWhere,
      select: {
        agentId: true,
        status: true,
        provider: true,
        costUsd: true,
        tokensIn: true,
        tokensOut: true,
        toolCalls: true,
        startedAt: true,
        endedAt: true,
        terminalAt: true,
      },
    }),
    prisma.executionEvent.count({
      where: { type: 'run_paused', ...(workspaceId === null ? {} : { workspaceId }) },
    }),
    prisma.agentRun.count({ where: { ...runWhere, status: { in: [...NON_TERMINAL_RUN_STATUSES] } } }),
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

  const terminalRuns = allRuns.filter((run) => run.terminalAt !== null && run.endedAt !== null)
  const durations = terminalRuns.map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime()).filter((ms) => ms >= 0)
  const spend = sumSpend(allRuns.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))
  const toolCalls = allRuns.reduce((n, run) => n + run.toolCalls, 0)

  const kpis: readonly Kpi[] = [
    {
      label: 'Task success rate',
      value: successDenominator === 0 ? '—' : `${Math.round((done / successDenominator) * 100)}%`,
      note: successDenominator === 0 ? 'no task has finished yet' : `${done} of ${successDenominator}`,
    },
    {
      label: 'Avg run duration',
      value: durations.length === 0 ? '—' : formatDuration(durations.reduce((a, b) => a + b, 0) / durations.length),
      note: durations.length === 0 ? null : `over ${durations.length} run(s)`,
    },
    {
      label: 'Spend',
      value: `$${spend.known.toFixed(2)}`,
      // Its own line, never folded into the figure (Decision 4): a total that silently absorbs
      // unmeasured runs as zeros presents the measured part of a bill as the whole of it.
      note: spend.unknownRuns === 0 ? null : `${spend.unknownRuns} run${spend.unknownRuns === 1 ? '' : 's'} unmeasured`,
    },
    { label: 'Tool calls', value: String(toolCalls), note: null },
    { label: 'Pauses', value: String(pauses), note: null },
    { label: 'Active agents', value: String(liveRuns), note: null },
  ]

  // ---- per-agent performance -------------------------------------------------------------
  const runsByAgent = new Map<string, typeof allRuns>()
  for (const run of allRuns) {
    const list = runsByAgent.get(run.agentId)
    if (list === undefined) runsByAgent.set(run.agentId, [run])
    else list.push(run)
  }

  const perAgent: readonly AgentPerformanceRow[] = agents.map((agent) => {
    const runs = runsByAgent.get(agent.id) ?? []
    const terminal = runs.filter((run) => run.terminalAt !== null)
    const succeeded = terminal.filter((run) => run.status === 'succeeded').length
    const agentDurations = terminal
      .filter((run) => run.endedAt !== null)
      .map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime())
      .filter((ms) => ms >= 0)
    const reported = runs.filter((run) => run.tokensIn !== null || run.tokensOut !== null)
    const agentSpend = sumSpend(runs.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      runs: terminal.length,
      successPct: terminal.length === 0 ? null : Math.round((succeeded / terminal.length) * 100),
      avgDurationMs: agentDurations.length === 0 ? null : agentDurations.reduce((a, b) => a + b, 0) / agentDurations.length,
      // `null` when NO run reported, a sum when some did (Decision 4). A partial sum is still a
      // real measurement of the runs that reported; a zero would be a claim about the ones that
      // did not.
      tokens: reported.length === 0 ? null : reported.reduce((n, run) => n + (run.tokensIn ?? 0) + (run.tokensOut ?? 0), 0),
      costUsd: agentSpend.known,
      unmeasuredRuns: agentSpend.unknownRuns,
    }
  })

  return { workspaceId, seeded: workspaceId === SEED_WORKSPACE_ID, series, kpis, perAgent }
}
