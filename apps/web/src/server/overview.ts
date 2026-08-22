import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@ai-team-os/domain'
import { feedSummary, type AgentFeedEvent } from '../lib/feedSummary'
import { bucketSparkline } from './activity'

// Re-exported so callers that already import from `server/overview.ts` keep working; the
// definition itself lives in the pure `lib/feedSummary.ts` module (controller ruling R3) so the
// client-side hook can import `feedSummary` without pulling `@ai-team-os/db`'s `prisma` client
// into the browser bundle. Types are erased at build, so re-exporting the interface here costs
// nothing at runtime.
export type { AgentFeedEvent }

/** How many of an agent's most recent events seed the panel's live feed (spec §6). */
const RECENT_EVENTS_LIMIT = 20

export interface AgentCardData {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly provider: 'claude-code'
  readonly status: AgentStatus
  readonly taskTitle: string | null
  readonly actionLine: string | null
  readonly runId: string | null
  /** The instruction queued for this agent's live run, consumed on resume (Checkpoint semantics). */
  readonly queuedMessage: string | null
  /** Set once a resume intent has been recorded for this run (`requestResume`), cleared the moment
   *  the daemon or CLI claims it (`claimResume`) — the panel's own visible record that the click
   *  landed while the run is still `paused` (spec §3.3). */
  readonly resumeRequestedAt: string | null
  /** Last 20 execution events for this agent, oldest first — seeds the panel's live feed. */
  readonly recentEvents: readonly AgentFeedEvent[]
  /** This agent's `run.tool_call` counts for the last 10 minutes, one bucket per minute, oldest
   *  minute first, zero-filled. */
  readonly sparkline: readonly number[]
  /** The live run's spend so far; 0 with no live run. Panel's current-run block (spec §6). */
  readonly costUsd: number
  /** The live run's tool call count so far; 0 with no live run. */
  readonly toolCalls: number
  /** Set only while a checkpoint exists to resume from — null outside `paused`. */
  readonly pausedAtStep: number | null
}

export interface OverviewSnapshot {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly haltedReason: string | null
    readonly haltedAt: string | null
    readonly budgetUsd: number
    readonly spentUsd: number
  }
  readonly agents: readonly AgentCardData[]
  readonly tasks: { readonly active: number; readonly blocked: number; readonly done: number; readonly failed: number }
}

const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'rework'] as const

export async function buildOverviewSnapshot(workspaceId: string): Promise<OverviewSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const agents = await prisma.agent.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
  })

  // One live run per agent at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically.
  const liveRuns = await prisma.agentRun.findMany({
    where: {
      agentId: { in: agents.map((a) => a.id) },
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
    },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunByAgent = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunByAgent.has(run.agentId)) liveRunByAgent.set(run.agentId, run)
  }

  // Initial action lines: the latest run.tool_call per live run, so a freshly opened page is not
  // blank until the next event. DB enum value is `run_tool_call`.
  const lines = new Map<string, string>()
  for (const run of liveRunByAgent.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call' },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const summary = (event.payload as { summary?: string }).summary
      if (typeof summary === 'string') lines.set(run.agentId, summary)
    }
  }

  // One query for every agent's recent events, not one per agent (the M4 review flagged
  // per-run queries as the first scaling cliff). `take` is generous enough that an even spread of
  // activity across agents leaves each with its own last 20; a single very chatty agent can still
  // crowd out a quiet one within this bound — accepted for M5, the brief's own reference query.
  const recentEventRows = await prisma.executionEvent.findMany({
    where: { agentId: { in: agents.map((a) => a.id) } },
    orderBy: { seq: 'desc' },
    take: RECENT_EVENTS_LIMIT * agents.length,
  })
  const recentEventsByAgent = new Map<string, AgentFeedEvent[]>()
  for (const row of recentEventRows) {
    if (row.agentId === null) continue
    const forAgent = recentEventsByAgent.get(row.agentId)
    if (forAgent !== undefined && forAgent.length >= RECENT_EVENTS_LIMIT) continue
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type
    const feedEvent: AgentFeedEvent = {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      summary: feedSummary(domainType, row.payload as Record<string, unknown>),
    }
    if (forAgent === undefined) recentEventsByAgent.set(row.agentId, [feedEvent])
    else forAgent.push(feedEvent)
  }
  // Rows arrived newest-first (capped per agent while iterating that order); the panel wants
  // oldest-first, newest at the bottom.
  for (const events of recentEventsByAgent.values()) events.reverse()

  // One grouped query for every agent's sparkline, not one per agent. The DB enum's stored value
  // is dotted (`'run.tool_call'`, confirmed against the schema and the test database — see
  // `toolCallSparkline` in `server/activity.ts`), not the Prisma member name `run_tool_call`.
  const sparklineNow = new Date()
  const sparklineRows = await prisma.$queryRaw<Array<{ agent_id: string | null; minute: Date; n: bigint }>>`
    SELECT "agentId" as agent_id, date_trunc('minute', ts) as minute, count(*) as n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND type = 'run.tool_call'::"EventType"
      AND ts >= now() - interval '10 minutes'
    GROUP BY 1, 2`
  const sparklineRowsByAgent = new Map<string, Array<{ minute: Date; n: bigint }>>()
  for (const row of sparklineRows) {
    if (row.agent_id === null) continue
    const forAgent = sparklineRowsByAgent.get(row.agent_id)
    if (forAgent === undefined) sparklineRowsByAgent.set(row.agent_id, [row])
    else forAgent.push(row)
  }

  const [spent, taskGroups] = await Promise.all([
    prisma.agentRun.aggregate({ where: { task: { workspaceId } }, _sum: { costUsd: true } }),
    prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
  ])
  const countOf = (statuses: readonly string[]): number =>
    taskGroups.filter((g) => statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0)

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      haltedReason: workspace.haltedReason,
      haltedAt: workspace.haltedAt?.toISOString() ?? null,
      budgetUsd: workspace.budgetUsd,
      spentUsd: spent._sum.costUsd ?? 0,
    },
    agents: agents.map((agent) => {
      const run = liveRunByAgent.get(agent.id) ?? null
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        // The single registered adapter (M3 §17.5). A column arrives with a second provider.
        provider: 'claude-code' as const,
        status: deriveAgentStatus(run === null ? null : toRunState(run)),
        taskTitle: run?.task.title ?? null,
        actionLine: lines.get(agent.id) ?? null,
        runId: run?.id ?? null,
        queuedMessage: run?.queuedMessage ?? null,
        resumeRequestedAt: run?.resumeRequestedAt?.toISOString() ?? null,
        recentEvents: recentEventsByAgent.get(agent.id) ?? [],
        sparkline: bucketSparkline(sparklineRowsByAgent.get(agent.id) ?? [], sparklineNow),
        costUsd: run?.costUsd ?? 0,
        toolCalls: run?.toolCalls ?? 0,
        pausedAtStep: run?.pausedAtStep ?? null,
      }
    }),
    tasks: {
      active: countOf([...ACTIVE_TASK_STATUSES]),
      blocked: countOf(['blocked']),
      done: countOf(['done']),
      failed: countOf(['failed']),
    },
  }
}
