import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { capabilitiesOf, type ProviderCapabilities, type ProviderKind } from '@ai-team-os/control'
import { deriveAgentStatus, sumSpend, NON_TERMINAL_RUN_STATUSES, type AgentStatus, type SpendRow } from '@ai-team-os/domain'

/** A worker's resolved gate, from `capabilitiesOf(worker.provider).gate` (M12 Task 13) -- `null`
 *  only when the worker itself has no provider recorded, mirroring `provider: ProviderKind | null`
 *  beside it. Named off `ProviderCapabilities['gate']` rather than redeclared, so the roster can
 *  never drift from the one capability table `@ai-team-os/providers` owns. */
export type WorkerGate = ProviderCapabilities['gate']

/**
 * The chain vocabulary `modelSource` already established (M11 Task 8 brief), reused verbatim for
 * `providerSource` (M12 Task 13 fix round 1, spec §8: "`modelSource` gains a provider counterpart
 * so the resolution chain stays legible"). Deliberately the SAME function computing both, rather
 * than two hand-written chains that could drift apart on the roster's own multi-workspace view --
 * this is the one place a member's own model/provider chain (worker override, then the roster
 * row, then the template default) is walked, which `resolveRuntime`'s worker-plus-workspace chain
 * (`packages/control/src/runtime.ts`) cannot stand in for: a roster member has no single
 * workspace to resolve a default against, and can carry several materialized workers whose own
 * overrides disagree -- `'worker-varies'` names exactly that roster-only case.
 */
type ChainSource = 'worker-varies' | 'roster' | 'template' | 'none'

function chainSource(hasWorkerOverride: boolean, rosterValue: unknown, templateValue: unknown): ChainSource {
  if (hasWorkerOverride) return 'worker-varies'
  if (rosterValue !== null) return 'roster'
  if (templateValue !== null) return 'template'
  return 'none'
}

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
  /** The workspace's own goal, one line -- the handoff's card description. `null` when unset, and
   *  the card then says so rather than inventing copy. */
  readonly goal: string | null
  /** The project's workers, for the avatar row: name and the tone their derived status resolves
   *  to. Capped at 6 -- a wider row wraps and stops reading as a team. */
  readonly team: readonly { readonly agentId: string; readonly name: string; readonly status: string }[]
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
  // `teams: { include: { agents: true } }` -- the avatar row's source. One join, not a
  // per-project query: every workspace's team roster comes back in this same round trip.
  const workspaces = await prisma.workspace.findMany({
    include: { company: true, teams: { include: { agents: true } } },
    orderBy: { name: 'asc' },
  })

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

  // The avatar row's live status, via the SAME `deriveAgentStatus` translator every other status
  // dot in the app uses (`loadAgentLiveInfo`, below) -- not a hand-rolled second read of the run
  // table. One call over every team member across every workspace, not one per project.
  const teamAgents = workspaces.flatMap((workspace) =>
    workspace.teams.flatMap((team) => team.agents.map((agent) => ({ agent, workspaceId: workspace.id }))),
  )
  const workspaceIdByTeamAgent = new Map(teamAgents.map(({ agent, workspaceId }) => [agent.id, workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(workspaces.map((w) => [w.id, w.maxToolCallsPerRun] as const))
  const teamAgentLiveInfo = await loadAgentLiveInfo(
    teamAgents.map(({ agent }) => agent.id),
    workspaceIdByTeamAgent,
    maxToolCallsByWorkspace,
  )

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
    goal: workspace.goal,
    taskCounts: {
      done: countOf(workspace.id, ['done']),
      total: totalOf(workspace.id),
      active: countOf(workspace.id, [...ACTIVE_TASK_STATUSES]),
      blocked: countOf(workspace.id, ['blocked']),
    },
    workerCount: workerCountByWorkspace.get(workspace.id) ?? 0,
    // Capped at six: the handoff's avatar row is one line, and a seventh tile wraps it into
    // something that no longer reads as a team at a glance.
    team: workspace.teams
      .flatMap((team) => team.agents)
      .slice(0, 6)
      .map((agent) => ({ agentId: agent.id, name: agent.name, status: teamAgentLiveInfo.get(agent.id)?.status ?? 'idle' })),
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
  readonly modelSource: ChainSource
  readonly rosterModel: string | null
  readonly templateDefaultModel: string | null
  /** `effectiveModel`'s pair (M12 Task 13 fix round 1, Important finding 3): the chain result
   *  IGNORING worker overrides, same as `effectiveModel` -- each worker's own provider shows in
   *  its sub-row below instead. */
  readonly effectiveProvider: ProviderKind | null
  /** `modelSource`'s pair (spec §8, fix round 1 finding 4b) -- the SAME chain, walked over the
   *  provider columns via `chainSource` above instead of the model columns. */
  readonly providerSource: ChainSource
  readonly workers: ReadonlyArray<{
    readonly agentId: string
    readonly workspaceId: string
    readonly projectName: string
    readonly status: string
    readonly model: string | null
    /**
     * The worker's OWN provider column (M12 Task 13) -- paired with `model` above the same way
     * every write site pairs them (`packages/control/src/org.ts`'s `pairRefusal`): set together,
     * or both `null`. Optional, not required: the M11 fixtures/tests that build a worker row by
     * hand predate this field and are not this task's to rewrite (Series A freeze) -- `undefined`
     * reads the same as `null` everywhere this is consumed.
     */
    readonly provider?: ProviderKind | null
    /** `capabilitiesOf(provider).gate`, or `null`/`undefined` when `provider` itself is not set --
     *  see `WorkerGate`'s own docstring, and `provider`'s above for why this is optional too. */
    readonly gate?: WorkerGate | null
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
            provider: worker.provider,
            gate: worker.provider !== null ? capabilitiesOf(worker.provider).gate : null,
            currentTask: info?.currentTask ?? null,
          }
        })
        const modelSource = chainSource(
          workers.some((w) => w.model !== null),
          member.model,
          member.template.defaultModel,
        )
        const providerSource = chainSource(
          workers.some((w) => w.provider !== null),
          member.provider,
          member.template.provider,
        )

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
          effectiveProvider: member.provider ?? member.template.provider ?? null,
          providerSource,
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
  /** The worker's team name -- the handoff's "department" column. */
  readonly department: string
  /**
   * The worker's LIVE run's provider, `null` with no live run (the `AgentCardData.provider` rule,
   * verbatim: a runtime is not decided until a run resolves it). A finished run's provider is
   * deliberately NOT read here -- it would keep naming a runtime after the agent went idle.
   */
  readonly provider: ProviderKind | null
  readonly gate: WorkerGate | null
  /** `tokensIn + tokensOut` summed over this worker's runs that reported them; `null` when none
   *  did (M14 Decision 4 -- Cursor reports none, and `0` would be a claim). */
  readonly tokens: number | null
  /** KNOWN spend across this worker's runs. */
  readonly costUsd: number
  readonly unmeasuredRuns: number
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

  const runs = await prisma.agentRun.findMany({
    where: { agentId: { in: agents.map((a) => a.id) } },
    select: { agentId: true, status: true, provider: true, costUsd: true, tokensIn: true, tokensOut: true, startedAt: true },
    orderBy: { startedAt: 'desc' },
  })
  const runsByAgent = new Map<string, typeof runs>()
  for (const run of runs) {
    const list = runsByAgent.get(run.agentId)
    if (list === undefined) runsByAgent.set(run.agentId, [run])
    else list.push(run)
  }

  return agents.map((agent) => {
    const info = liveInfo.get(agent.id)
    const agentRuns = runsByAgent.get(agent.id) ?? []
    const reported = agentRuns.filter((r) => r.tokensIn !== null || r.tokensOut !== null)
    const liveProvider = agentRuns.find((r) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status))?.provider ?? null
    const { spend, unmeasuredRuns } = spendOf(agentRuns)
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      workspaceId: agent.team.workspaceId,
      projectName: agent.team.workspace.name,
      status: info?.status ?? 'idle',
      currentTask: info?.currentTask ?? null,
      department: agent.team.name,
      provider: liveProvider,
      gate: liveProvider === null ? null : capabilitiesOf(liveProvider).gate,
      tokens: reported.length === 0 ? null : reported.reduce((n, r) => n + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0),
      costUsd: spend,
      unmeasuredRuns,
    }
  })
}

export async function listTemplates(): Promise<
  readonly {
    id: string
    name: string
    role: string
    description: string
    defaultModel: string | null
    defaultProvider: ProviderKind | null
  }[]
> {
  const templates = await prisma.agentTemplate.findMany({
    select: { id: true, name: true, role: true, description: true, defaultModel: true, provider: true },
    orderBy: { name: 'asc' },
  })
  return templates.map(({ provider, ...rest }) => ({ ...rest, defaultProvider: provider }))
}

export async function listCompanies(): Promise<readonly { id: string; name: string }[]> {
  return prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
