import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@ai-team-os/domain'

export interface AgentCardData {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly provider: 'claude-code'
  readonly status: AgentStatus
  readonly taskTitle: string | null
  readonly actionLine: string | null
  readonly runId: string | null
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
