import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, sumSpend, NON_TERMINAL_RUN_STATUSES, type AgentStatus, type SpendRow } from '@ai-team-os/domain'

// Mirrors overview.ts's ACTIVE_TASK_STATUSES exactly (the M8a widening: a task under review or in
// the merge queue is still active work). Not imported from there -- overview.ts does not export
// it, and this task's scope is one new module, nothing else changes.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework'] as const

/** `sumSpend`'s pair under this DTO's own field names. */
function spendOf(runs: readonly SpendRow[]): { readonly spend: number; readonly unmeasuredRuns: number } {
  const { known, unknownRuns } = sumSpend(runs)
  return { spend: known, unmeasuredRuns: unknownRuns }
}

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly companyName: string | null
  readonly halted: boolean
  readonly taskCounts: { readonly done: number; readonly total: number; readonly active: number; readonly blocked: number }
  readonly workerCount: number
  /** KNOWN spend: every run of this project that reported a cost, summed. */
  readonly spend: number
  /**
   * How many of this project's runs actually ran, finished, and left no cost figure behind (M12
   * Task 9, ruling R3; corrected in fix round F1). Rendered as its own stat rather than folded
   * into `spend`, because a total that silently absorbs unmeasured runs as zeros presents the
   * measured part of a bill as the whole of it. NOT the count of null `costUsd` columns --
   * `sumSpend` holds the rule.
   */
  readonly unmeasuredRuns: number
}

export async function listProjects(): Promise<readonly ProjectRow[]> {
  const workspaces = await prisma.workspace.findMany({ include: { company: true }, orderBy: { name: 'asc' } })

  const [taskGroups, spendRows, workerAgents] = await Promise.all([
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // `agent -> team -> workspaceId`, matching overview.ts's budget-bar spend source exactly: a
    // `planning` run (no Task row) still counts toward the workspace it ran under.
    // `provider` and `status` alongside the cost: those two are what tell an unmeasured run from a
    // null cost (`sumSpend` carries the rule and the column facts). Not filtered in SQL -- a
    // pre-M12 row has a real cost and a null `provider`, so a `WHERE` would drop its money out of
    // `spend` in order to fix `unmeasuredRuns` beside it.
    prisma.agentRun.findMany({
      select: {
        costUsd: true,
        provider: true,
        status: true,
        agent: { select: { team: { select: { workspaceId: true } } } },
      },
    }),
    prisma.agent.findMany({ where: { companyAgentId: { not: null } }, select: { team: { select: { workspaceId: true } } } }),
  ])

  // Grouped first, then summed through `sumSpend` (M12 Task 9, ruling R3). The old running total
  // added `(run.costUsd ?? 0)` per row, which is the array form of the same defect the `_sum` sites
  // had: a run nobody measured contributed a zero and then vanished from the figure entirely.
  // `sumSpend` is the same function `overview.ts` uses, so the two surfaces that show an operator
  // a spend figure cannot come to disagree about what an unmeasured run does to a total.
  // `world.ts`'s guardrail is deliberately NOT the third (fix round F3): its consumer is
  // forbidden to read `unknownRuns` (ruling R8), so the pair's second half would be discarded --
  // and its query runs inside `loadWorld`'s cumulative-15s transaction on the tick's hot path,
  // where `_sum` transfers one row instead of one float per run of the workspace's history. The
  // difference between these sites is the CONSUMER, not the arithmetic.
  const rowsByWorkspace = new Map<string, SpendRow[]>()
  for (const run of spendRows) {
    const workspaceId = run.agent.team.workspaceId
    const row: SpendRow = { costUsd: run.costUsd, provider: run.provider, status: run.status }
    const forWorkspace = rowsByWorkspace.get(workspaceId)
    if (forWorkspace === undefined) rowsByWorkspace.set(workspaceId, [row])
    else forWorkspace.push(row)
  }

  const workerCountByWorkspace = new Map<string, number>()
  for (const row of workerAgents) {
    const workspaceId = row.team.workspaceId
    workerCountByWorkspace.set(workspaceId, (workerCountByWorkspace.get(workspaceId) ?? 0) + 1)
  }

  const countOf = (workspaceId: string, statuses: readonly string[]): number =>
    taskGroups
      .filter((g) => g.workspaceId === workspaceId && statuses.includes(g.status))
      .reduce((n, g) => n + g._count._all, 0)
  const totalOf = (workspaceId: string): number =>
    taskGroups.filter((g) => g.workspaceId === workspaceId).reduce((n, g) => n + g._count._all, 0)

  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    companyName: workspace.company?.name ?? null,
    halted: workspace.haltedReason !== null,
    taskCounts: {
      done: countOf(workspace.id, ['done']),
      total: totalOf(workspace.id),
      active: countOf(workspace.id, [...ACTIVE_TASK_STATUSES]),
      blocked: countOf(workspace.id, ['blocked']),
    },
    workerCount: workerCountByWorkspace.get(workspace.id) ?? 0,
    // `?? []` here is the case `?? 0` was always right about: a workspace with no runs at all has
    // spent nothing and has nothing unmeasured -- `sumSpend([])` says exactly that.
    ...spendOf(rowsByWorkspace.get(workspace.id) ?? []),
  }))
}

interface CurrentTask {
  readonly title: string
  readonly pct: number
}

interface AgentLiveInfo {
  readonly status: AgentStatus
  readonly currentTask: CurrentTask | null
}

/**
 * Status + current task for a set of worker agents, derived the same way overview.ts derives an
 * agent card's status and task title: the agent's one non-terminal run, via `deriveAgentStatus`
 * (ADR 0002's only translator -- never re-derived from the raw run status here).
 *
 * `currentTask.pct` has no analogue in overview.ts (`AgentCardData` carries no per-agent progress
 * figure) -- there is no other progress signal already stored for a run, so this reuses the run's
 * `toolCalls` against its *workspace's* `maxToolCallsPerRun` budget, clamped to [0, 100]. A `null`
 * `currentTask` also covers a live `planning` run, which has no `Task` row (M8b).
 */
async function loadAgentLiveInfo(
  agentIds: readonly string[],
  workspaceIdByAgent: ReadonlyMap<string, string>,
  maxToolCallsByWorkspace: ReadonlyMap<string, number>,
): Promise<Map<string, AgentLiveInfo>> {
  const liveRuns = await prisma.agentRun.findMany({
    where: { agentId: { in: [...agentIds] }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunByAgent = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunByAgent.has(run.agentId)) liveRunByAgent.set(run.agentId, run)
  }

  const result = new Map<string, AgentLiveInfo>()
  for (const agentId of agentIds) {
    const run = liveRunByAgent.get(agentId) ?? null
    const status = deriveAgentStatus(run === null ? null : toRunState(run))
    let currentTask: CurrentTask | null = null
    if (run !== null && run.task !== null) {
      const maxToolCalls = maxToolCallsByWorkspace.get(workspaceIdByAgent.get(agentId) ?? '') ?? 0
      const pct = maxToolCalls > 0 ? Math.min(100, Math.max(0, Math.round((run.toolCalls / maxToolCalls) * 100))) : 0
      currentTask = { title: run.task.title, pct }
    }
    result.set(agentId, { status, currentTask })
  }
  return result
}

export interface RosterMemberRow {
  readonly companyAgentId: string
  readonly name: string
  readonly role: string
  readonly templateName: string
  readonly effectiveModel: string | null
  readonly modelSource: 'worker-varies' | 'roster' | 'template' | 'none'
  readonly rosterModel: string | null
  readonly templateDefaultModel: string | null
  readonly workers: ReadonlyArray<{
    readonly agentId: string
    readonly workspaceId: string
    readonly projectName: string
    readonly status: string
    readonly model: string | null
    readonly currentTask: CurrentTask | null
  }>
}

export interface RosterCompany {
  readonly companyId: string
  readonly companyName: string
  readonly teams: ReadonlyArray<{
    readonly companyTeamId: string
    readonly teamName: string
    readonly members: readonly RosterMemberRow[]
  }>
}

export async function listRoster(): Promise<readonly RosterCompany[]> {
  const companies = await prisma.company.findMany({
    orderBy: { name: 'asc' },
    include: {
      teams: {
        orderBy: { name: 'asc' },
        include: {
          agents: {
            orderBy: { name: 'asc' },
            include: {
              template: true,
              workers: { include: { team: { include: { workspace: true } } } },
            },
          },
        },
      },
    },
  })

  const allWorkers = companies.flatMap((c) => c.teams.flatMap((t) => t.agents.flatMap((a) => a.workers)))
  const workspaceIdByAgent = new Map(allWorkers.map((w) => [w.id, w.team.workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(allWorkers.map((w) => [w.team.workspaceId, w.team.workspace.maxToolCallsPerRun] as const))
  const liveInfo = await loadAgentLiveInfo(
    allWorkers.map((w) => w.id),
    workspaceIdByAgent,
    maxToolCallsByWorkspace,
  )

  return companies.map((company) => ({
    companyId: company.id,
    companyName: company.name,
    teams: company.teams.map((team) => ({
      companyTeamId: team.id,
      teamName: team.name,
      members: team.agents.map((member) => {
        const workers = member.workers.map((worker) => {
          const info = liveInfo.get(worker.id)
          return {
            agentId: worker.id,
            workspaceId: worker.team.workspaceId,
            projectName: worker.team.workspace.name,
            status: info?.status ?? 'idle',
            model: worker.model,
            currentTask: info?.currentTask ?? null,
          }
        })
        const hasWorkerOverride = workers.some((w) => w.model !== null)
        const modelSource: RosterMemberRow['modelSource'] = hasWorkerOverride
          ? 'worker-varies'
          : member.model !== null
            ? 'roster'
            : member.template.defaultModel !== null
              ? 'template'
              : 'none'

        return {
          companyAgentId: member.id,
          name: member.name,
          role: member.template.role,
          templateName: member.template.name,
          // The chain result IGNORING worker overrides -- each worker's own value shows in its
          // sub-row above instead.
          effectiveModel: member.model ?? member.template.defaultModel ?? null,
          modelSource,
          rosterModel: member.model,
          templateDefaultModel: member.template.defaultModel,
          workers,
        }
      }),
    })),
  }))
}

export interface WorkerRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly workspaceId: string
  readonly projectName: string
  readonly status: string
  readonly currentTask: CurrentTask | null
}

export async function listWorkers(): Promise<readonly WorkerRow[]> {
  const agents = await prisma.agent.findMany({
    where: { companyAgentId: { not: null } },
    orderBy: { name: 'asc' },
    include: { team: { include: { workspace: true } } },
  })

  const workspaceIdByAgent = new Map(agents.map((a) => [a.id, a.team.workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(agents.map((a) => [a.team.workspaceId, a.team.workspace.maxToolCallsPerRun] as const))
  const liveInfo = await loadAgentLiveInfo(
    agents.map((a) => a.id),
    workspaceIdByAgent,
    maxToolCallsByWorkspace,
  )

  return agents.map((agent) => {
    const info = liveInfo.get(agent.id)
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      workspaceId: agent.team.workspaceId,
      projectName: agent.team.workspace.name,
      status: info?.status ?? 'idle',
      currentTask: info?.currentTask ?? null,
    }
  })
}

export async function listTemplates(): Promise<
  readonly { id: string; name: string; role: string; description: string; defaultModel: string | null }[]
> {
  return prisma.agentTemplate.findMany({
    select: { id: true, name: true, role: true, description: true, defaultModel: true },
    orderBy: { name: 'asc' },
  })
}

export async function listCompanies(): Promise<readonly { id: string; name: string }[]> {
  return prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
