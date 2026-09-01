import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { capabilitiesOf, type ProviderCapabilities, type ProviderKind } from '@ai-team-os/control'
import {
  deriveAgentStatus,
  sumSpendFromGroups,
  NON_TERMINAL_RUN_STATUSES,
  type AgentStatus,
  type SpendGroup,
} from '@ai-team-os/domain'

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

/** `sumSpendFromGroups`'s pair under this DTO's own field names (`listProjects` and `listWorkers`
 *  below both group in SQL and share this one wrapper -- `spendOf`, the equivalent wrapper over a
 *  whole-history row array, was deleted in the M19 Task 12 rewrite once `listWorkers` stopped being
 *  its last caller). */
function spendOfGroups(groups: readonly SpendGroup[]): { readonly spend: number; readonly unmeasuredRuns: number } {
  const { known, unknownRuns } = sumSpendFromGroups(groups)
  return { spend: known, unmeasuredRuns: unknownRuns }
}

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly companyName: string | null
  readonly halted: boolean
  readonly taskCounts: { readonly done: number; readonly total: number; readonly active: number; readonly blocked: number }
  /**
   * How many agents this workspace has (M14 fix wave, ruling on review I4): every `Agent` row on
   * one of its teams, staffed from a company or not. ONE definition of "agent", shared with
   * `listWorkers` below and with the `team` avatar row on this very same DTO -- the card used to
   * show `AGENTS 0` above six avatar tiles because the tile counted `companyAgentId != null` and
   * the row counted team membership. Company staffing is optional metadata about an agent, never
   * what makes one.
   */
  readonly workerCount: number
  /** The workspace's own goal, one line -- the handoff's card description. `null` when unset, and
   *  the card then says so rather than inventing copy. */
  readonly goal: string | null
  /** The project's workers, for the avatar row: name and the tone their derived status resolves
   *  to. The FULL team, uncapped -- `ProjectsClient.tsx` owns the six-avatar cap and the `+N`
   *  overflow tile that reads past it (fix round 1). */
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

  const [taskGroups, agentRows, spendGroups] = await Promise.all([
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // `agent -> team -> workspaceId`, matching overview.ts's budget-bar spend source exactly (Task
    // 13, M17): a `planning` run (no Task row) still counts toward the workspace it ran under.
    // Prisma's `groupBy` cannot traverse a relation for its `by` columns, so the workspace each
    // agent belongs to is resolved with this separate, cheap query instead.
    prisma.agent.findMany({ select: { id: true, team: { select: { workspaceId: true } } } }),
    // Grouped by the database rather than pulled row-by-row: `provider` and `status` alongside the
    // summed/counted cost are what tell an unmeasured run from a null cost (`sumSpend`'s doc
    // comment carries the rule and the column facts; `sumSpendFromGroups` restates it over
    // buckets). Not filtered in SQL -- a pre-M12 row has a real cost and a null `provider`, so a
    // `WHERE` would drop its money out of `spend` in order to fix `unmeasuredRuns` beside it.
    prisma.agentRun.groupBy({
      by: ['agentId', 'provider', 'status'],
      _sum: { costUsd: true },
      _count: { _all: true, costUsd: true },
    }),
  ])

  // Grouped first, then summed through `sumSpendFromGroups` (M12 Task 9 ruling R3; M17 Task 13's
  // grouped rewrite). The old running total added `(run.costUsd ?? 0)` per row, which is the array
  // form of the same defect the `_sum` sites had: a run nobody measured contributed a zero and then
  // vanished from the figure entirely. `sumSpend`/`sumSpendFromGroups` are the same functions
  // `overview.ts` uses, so the two surfaces that show an operator a spend figure cannot come to
  // disagree about what an unmeasured run does to a total.
  // `world.ts`'s guardrail is deliberately NOT the third (fix round F3): its consumer is
  // forbidden to read `unknownRuns` (ruling R8), so the pair's second half would be discarded --
  // and its query runs inside `loadWorld`'s cumulative-15s transaction on the tick's hot path,
  // where `_sum` transfers one row instead of one float per run of the workspace's history. The
  // difference between these sites is the CONSUMER, not the arithmetic.
  const workspaceByAgent = new Map(agentRows.map((agent) => [agent.id, agent.team.workspaceId]))
  const groupsByWorkspace = new Map<string, SpendGroup[]>()
  for (const g of spendGroups) {
    const workspaceId = workspaceByAgent.get(g.agentId)
    if (workspaceId === undefined) continue
    const group: SpendGroup = {
      provider: g.provider,
      // Prisma's generated `groupBy` status is its own enum type, distinct from the domain's
      // `RunStatus` import -- assignable here with no cast because they are the SAME nine members
      // (schema.prisma:25-35 = state.ts:3), verified against the schema rather than assumed.
      status: g.status,
      knownUsd: g._sum.costUsd ?? 0,
      rowCount: g._count._all,
      measuredCount: g._count.costUsd,
    }
    const list = groupsByWorkspace.get(workspaceId)
    if (list === undefined) groupsByWorkspace.set(workspaceId, [group])
    else list.push(group)
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
    // Counted off the SAME `workspace.teams[].agents` array the avatar row below is built from, so
    // the `AGENTS` tile and the row of faces beside it cannot disagree (review I4). No separate
    // query: a second read is a second chance to answer the same question differently.
    workerCount: workspace.teams.reduce((n, team) => n + team.agents.length, 0),
    // The FULL team, uncapped (fix round 1: the six-avatar cap moved client-side in
    // `ProjectsClient.tsx` back in Task 4, and a server-side `.slice(0, 6)` on top of it made the
    // `+N` overflow tile structurally unreachable -- the client never saw a team longer than six to
    // know it was showing a prefix. Bounded by the workspace's own agent count, which is never
    // unbounded in practice.
    team: workspace.teams
      .flatMap((team) => team.agents)
      .map((agent) => ({ agentId: agent.id, name: agent.name, status: teamAgentLiveInfo.get(agent.id)?.status ?? 'idle' })),
    // `?? []` here is the case `?? 0` was always right about: a workspace with no runs at all has
    // spent nothing and has nothing unmeasured -- `sumSpendFromGroups([])` says exactly that.
    ...spendOfGroups(groupsByWorkspace.get(workspace.id) ?? []),
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

/**
 * Every agent, across every workspace, as the Agents page's seven-column table (design README
 * §3a.2).
 *
 * NO `companyAgentId` filter (M14 fix wave, ruling on review I4): an agent is any `Agent` row on
 * a workspace's team, and being staffed from a company roster is optional. The old
 * `where: { companyAgentId: { not: null } }` made "worker" mean "roster-linked", which rendered
 * the table as a bare header on any development database whose agents were created by hand --
 * and disagreed with `listProjects`'s avatar row about how many agents a project has.
 * `department` is the agent's TEAM name, which every agent has; `companyName` may be null, and
 * that is not a reason to hide an agent from the page that lists agents.
 */
export async function listWorkers(): Promise<readonly WorkerRow[]> {
  const agents = await prisma.agent.findMany({
    orderBy: { name: 'asc' },
    include: { team: { include: { workspace: true } } },
  })
  const agentIds = agents.map((a) => a.id)

  const workspaceIdByAgent = new Map(agents.map((a) => [a.id, a.team.workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(agents.map((a) => [a.team.workspaceId, a.team.workspace.maxToolCallsPerRun] as const))

  const [liveInfo, runGroups, liveRuns] = await Promise.all([
    loadAgentLiveInfo(agentIds, workspaceIdByAgent, maxToolCallsByWorkspace),
    // Grouped by the database (M19 Task 12; the same move `listProjects`' spend groups made in M17
    // Task 13), now also carrying `tokensIn`/`tokensOut` so `tokens` can be summed without pulling
    // every run into memory. `_count.tokensIn`/`_count.tokensOut` count only the bucket's non-null
    // values -- exactly what `tokens`'s null rule needs: a bucket where NEITHER column was ever
    // reported still has a `_sum` of `null` (indistinguishable from "summed to zero"), so the count
    // beside it is what tells the two apart.
    prisma.agentRun.groupBy({
      by: ['agentId', 'provider', 'status'],
      where: { agentId: { in: agentIds } },
      _sum: { costUsd: true, tokensIn: true, tokensOut: true },
      _count: { _all: true, costUsd: true, tokensIn: true, tokensOut: true },
    }),
    // The live provider, as a SEPARATE bounded query rather than read off the grouped rows above --
    // `groupBy` can only aggregate a bucket, never return "the newest row in it". In-flight runs
    // are few by construction (at most one non-terminal run per agent in the steady state), so this
    // stays cheap while preserving today's newest-first pick exactly.
    prisma.agentRun.findMany({
      where: { agentId: { in: agentIds }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
      select: { agentId: true, provider: true, startedAt: true },
      orderBy: { startedAt: 'desc' },
    }),
  ])

  // Same `SpendGroup` construction as `listProjects` above, keyed by agent instead of workspace.
  // `tokenTotalsByAgent` is `spendGroupsByAgent`'s token-side twin: `sum` accumulates unconditionally
  // (a group nobody reported tokens in has a `_sum` of `null`, so `?? 0` contributes nothing),
  // `reported` is set the moment ANY group of the agent shows a non-zero token count -- the null
  // rule is about whether the agent EVER reported, not whether any one bucket did.
  const spendGroupsByAgent = new Map<string, SpendGroup[]>()
  const tokenTotalsByAgent = new Map<string, { sum: number; reported: boolean }>()
  for (const g of runGroups) {
    const spendGroup: SpendGroup = {
      provider: g.provider,
      status: g.status,
      knownUsd: g._sum.costUsd ?? 0,
      rowCount: g._count._all,
      measuredCount: g._count.costUsd,
    }
    const spendList = spendGroupsByAgent.get(g.agentId)
    if (spendList === undefined) spendGroupsByAgent.set(g.agentId, [spendGroup])
    else spendList.push(spendGroup)

    const totals = tokenTotalsByAgent.get(g.agentId) ?? { sum: 0, reported: false }
    totals.sum += (g._sum.tokensIn ?? 0) + (g._sum.tokensOut ?? 0)
    if (g._count.tokensIn > 0 || g._count.tokensOut > 0) totals.reported = true
    tokenTotalsByAgent.set(g.agentId, totals)
  }

  // First row per agent wins -- `liveRuns` is ordered newest-first, so this is the newer of an
  // agent's non-terminal runs when it has more than one. (Review Minor: `orderBy` here is a single
  // key, `startedAt` -- two non-terminal runs of the same agent with an EXACTLY equal `startedAt`
  // tie-break in whatever order Postgres returns them, which is unspecified. Pre-existing: the
  // prior whole-history `findMany` this replaced ordered by the same single `startedAt` key.)
  const liveProviderByAgent = new Map<string, (typeof liveRuns)[number]['provider']>()
  for (const run of liveRuns) {
    if (!liveProviderByAgent.has(run.agentId)) liveProviderByAgent.set(run.agentId, run.provider)
  }

  return agents.map((agent) => {
    const info = liveInfo.get(agent.id)
    const liveProvider = liveProviderByAgent.get(agent.id) ?? null
    const { spend, unmeasuredRuns } = spendOfGroups(spendGroupsByAgent.get(agent.id) ?? [])
    const tokenTotals = tokenTotalsByAgent.get(agent.id)
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
      tokens: tokenTotals === undefined || !tokenTotals.reported ? null : tokenTotals.sum,
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
