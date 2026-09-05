import { prisma } from '@slave-of-ai/db/client'
import { toRunState } from '@slave-of-ai/db'
import { capabilitiesOf, type ProviderCapabilities, type ProviderKind } from '@slave-of-ai/control'
import {
  deriveSlaveStatus,
  sumSpendFromGroups,
  NON_TERMINAL_RUN_STATUSES,
  type SlaveStatus,
  type SpendGroup,
} from '@slave-of-ai/domain'

/** A worker's resolved gate, from `capabilitiesOf(worker.provider).gate` (M12 Task 13) -- `null`
 *  only when the worker itself has no provider recorded, mirroring `provider: ProviderKind | null`
 *  beside it. Named off `ProviderCapabilities['gate']` rather than redeclared, so the roster can
 *  never drift from the one capability table `@slave-of-ai/providers` owns. */
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

/** Every list read below's default filter (M27 §3.3): an archived project has `archivedAt !==
 *  null` and is hidden from every list unless a caller opts in with `includeArchived: true`
 *  (the Projects page's `show archived` toggle is the one caller that does -- every other read
 *  keeps the default). A bare `{}` puts no constraint on `archivedAt` at all, rather than an
 *  `{ archivedAt: { not: null } }` that would flip the toggle into an archived-ONLY view nothing
 *  asks for. */
const notArchived = (includeArchived?: boolean): { archivedAt?: null } => (includeArchived === true ? {} : { archivedAt: null })

/** Whether a project is archived -- `ProjectHeader`'s chip and `ProjectSettingsClient`'s danger
 *  zone both need this one flag with no other row data. */
export async function workspaceArchived(workspaceId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { archivedAt: true } })
  return workspace !== null && workspace.archivedAt !== null
}

/** `sumSpendFromGroups`'s pair under this DTO's own field names (`listProjects` and `listWorkers`
 *  below both group in SQL and share this one wrapper -- `spendOf`, the equivalent wrapper over a
 *  whole-history row array, was deleted in the M19 Task 12 rewrite once `listWorkers` stopped being
 *  its last caller). */
export function spendOfGroups(groups: readonly SpendGroup[]): { readonly spend: number; readonly unmeasuredRuns: number } {
  const { known, unknownRuns } = sumSpendFromGroups(groups)
  return { spend: known, unmeasuredRuns: unknownRuns }
}

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly companyName: string | null
  readonly halted: boolean
  /** M27 §3.3: `Workspace.archivedAt !== null`. The Projects page's `archived` chip and its
   *  Restore button key off this; `listProjects()`'s default hides the row entirely, so a caller
   *  that never passes `includeArchived: true` never sees `archived: true` at all. */
  readonly archived: boolean
  readonly taskCounts: { readonly done: number; readonly total: number; readonly active: number; readonly blocked: number }
  /**
   * How many slaves this workspace has (M14 fix wave, ruling on review I4): every `Slave` row on
   * one of its teams, staffed from a company or not. ONE definition of "slave", shared with
   * `listWorkers` below and with the `team` avatar row on this very same DTO -- the card used to
   * show `SLAVES 0` above six avatar tiles because the tile counted `companySlaveId != null` and
   * the row counted team membership. Company staffing is optional metadata about a slave, never
   * what makes one.
   */
  readonly workerCount: number
  /** The workspace's own goal, one line -- the handoff's card description. `null` when unset, and
   *  the card then says so rather than inventing copy. */
  readonly goal: string | null
  /** The project's workers, for the avatar row: name and the tone their derived status resolves
   *  to. The FULL team, uncapped -- `ProjectsClient.tsx` owns the six-avatar cap and the `+N`
   *  overflow tile that reads past it (fix round 1). */
  readonly team: readonly { readonly slaveId: string; readonly name: string; readonly status: string }[]
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

/** Every project (M27 §3.3, §7): hides an archived project by default -- `options?.includeArchived`
 *  is the Projects page's `show archived` toggle, the one caller that passes `true`. */
export async function listProjects(options?: { readonly includeArchived?: boolean }): Promise<readonly ProjectRow[]> {
  // `teams: { include: { slaves: true } }` -- the avatar row's source. One join, not a
  // per-project query: every workspace's team roster comes back in this same round trip.
  const workspaces = await prisma.workspace.findMany({
    where: notArchived(options?.includeArchived),
    include: { company: true, teams: { include: { slaves: true } } },
    orderBy: { name: 'asc' },
  })

  const [taskGroups, slaveRows, spendGroups] = await Promise.all([
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // `slave -> team -> workspaceId`, matching overview.ts's budget-bar spend source exactly (Task
    // 13, M17): a `planning` run (no Task row) still counts toward the workspace it ran under.
    // Prisma's `groupBy` cannot traverse a relation for its `by` columns, so the workspace each
    // slave belongs to is resolved with this separate, cheap query instead.
    prisma.slave.findMany({ select: { id: true, team: { select: { workspaceId: true } } } }),
    // Grouped by the database rather than pulled row-by-row: `provider` and `status` alongside the
    // summed/counted cost are what tell an unmeasured run from a null cost (`sumSpend`'s doc
    // comment carries the rule and the column facts; `sumSpendFromGroups` restates it over
    // buckets). Not filtered in SQL -- a pre-M12 row has a real cost and a null `provider`, so a
    // `WHERE` would drop its money out of `spend` in order to fix `unmeasuredRuns` beside it.
    prisma.slaveRun.groupBy({
      by: ['slaveId', 'provider', 'status'],
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
  const workspaceBySlave = new Map(slaveRows.map((slave) => [slave.id, slave.team.workspaceId]))
  const groupsByWorkspace = new Map<string, SpendGroup[]>()
  for (const g of spendGroups) {
    const workspaceId = workspaceBySlave.get(g.slaveId)
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

  // The avatar row's live status, via the SAME `deriveSlaveStatus` translator every other status
  // dot in the app uses (`loadSlaveLiveInfo`, below) -- not a hand-rolled second read of the run
  // table. One call over every team member across every workspace, not one per project.
  const teamSlaves = workspaces.flatMap((workspace) =>
    workspace.teams.flatMap((team) => team.slaves.map((slave) => ({ slave, workspaceId: workspace.id }))),
  )
  const workspaceIdByTeamSlave = new Map(teamSlaves.map(({ slave, workspaceId }) => [slave.id, workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(workspaces.map((w) => [w.id, w.maxToolCallsPerRun] as const))
  const teamSlaveLiveInfo = await loadSlaveLiveInfo(
    teamSlaves.map(({ slave }) => slave.id),
    workspaceIdByTeamSlave,
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
    archived: workspace.archivedAt !== null,
    goal: workspace.goal,
    taskCounts: {
      done: countOf(workspace.id, ['done']),
      total: totalOf(workspace.id),
      active: countOf(workspace.id, [...ACTIVE_TASK_STATUSES]),
      blocked: countOf(workspace.id, ['blocked']),
    },
    // Counted off the SAME `workspace.teams[].slaves` array the avatar row below is built from, so
    // the `SLAVES` tile and the row of faces beside it cannot disagree (review I4). No separate
    // query: a second read is a second chance to answer the same question differently.
    workerCount: workspace.teams.reduce((n, team) => n + team.slaves.length, 0),
    // The FULL team, uncapped (fix round 1: the six-avatar cap moved client-side in
    // `ProjectsClient.tsx` back in Task 4, and a server-side `.slice(0, 6)` on top of it made the
    // `+N` overflow tile structurally unreachable -- the client never saw a team longer than six to
    // know it was showing a prefix. Bounded by the workspace's own slave count, which is never
    // unbounded in practice.
    team: workspace.teams
      .flatMap((team) => team.slaves)
      .map((slave) => ({ slaveId: slave.id, name: slave.name, status: teamSlaveLiveInfo.get(slave.id)?.status ?? 'idle' })),
    // `?? []` here is the case `?? 0` was always right about: a workspace with no runs at all has
    // spent nothing and has nothing unmeasured -- `sumSpendFromGroups([])` says exactly that.
    ...spendOfGroups(groupsByWorkspace.get(workspace.id) ?? []),
  }))
}

/** Every workspace by name, for the project header's switcher (M24 §2.2), the New department and
 *  New slave forms' project pickers, and `listWorkspaces` (`server/workspaces.ts`). Two columns,
 *  no joins: `listProjects` exists for the cards and is far heavier than a dropdown needs. Hides
 *  an archived project by default (M27 §3.3) -- the switcher never lists one, matching the rule
 *  that an archived project leaves the header's world entirely. */
export async function listWorkspaceNames(
  options?: { readonly includeArchived?: boolean },
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return prisma.workspace.findMany({
    where: notArchived(options?.includeArchived),
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

interface CurrentTask {
  readonly title: string
  readonly pct: number
}

interface SlaveLiveInfo {
  readonly status: SlaveStatus
  readonly currentTask: CurrentTask | null
}

/**
 * Status + current task for a set of worker slaves, derived the same way overview.ts derives an
 * slave card's status and task title: the slave's one non-terminal run, via `deriveSlaveStatus`
 * (ADR 0002's only translator -- never re-derived from the raw run status here).
 *
 * `currentTask.pct` has no analogue in overview.ts (`SlaveCardData` carries no per-slave progress
 * figure) -- there is no other progress signal already stored for a run, so this reuses the run's
 * `toolCalls` against its *workspace's* `maxToolCallsPerRun` budget, clamped to [0, 100]. A `null`
 * `currentTask` also covers a live `planning` run, which has no `Task` row (M8b).
 */
async function loadSlaveLiveInfo(
  slaveIds: readonly string[],
  workspaceIdBySlave: ReadonlyMap<string, string>,
  maxToolCallsByWorkspace: ReadonlyMap<string, number>,
): Promise<Map<string, SlaveLiveInfo>> {
  const liveRuns = await prisma.slaveRun.findMany({
    where: { slaveId: { in: [...slaveIds] }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunBySlave = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunBySlave.has(run.slaveId)) liveRunBySlave.set(run.slaveId, run)
  }

  const result = new Map<string, SlaveLiveInfo>()
  for (const slaveId of slaveIds) {
    const run = liveRunBySlave.get(slaveId) ?? null
    const status = deriveSlaveStatus(run === null ? null : toRunState(run))
    let currentTask: CurrentTask | null = null
    if (run !== null && run.task !== null) {
      const maxToolCalls = maxToolCallsByWorkspace.get(workspaceIdBySlave.get(slaveId) ?? '') ?? 0
      const pct = maxToolCalls > 0 ? Math.min(100, Math.max(0, Math.round((run.toolCalls / maxToolCalls) * 100))) : 0
      currentTask = { title: run.task.title, pct }
    }
    result.set(slaveId, { status, currentTask })
  }
  return result
}

export interface RosterMemberRow {
  readonly companySlaveId: string
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
    readonly slaveId: string
    /** The worker's OWN `Slave.name`/`Slave.role` (M23 D2) -- distinct from this roster member's
     *  `name`/`role` above, which are the CATALOG identity a worker starts from at materialization
     *  and can since have drifted from via `renameSlave`/`setSlaveRole`. `SlaveRowActions` edits
     *  these two, not the roster row. */
    readonly name: string
    readonly role: string
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
  /** How many projects have this company assigned (`Workspace.companyId`) -- the Team catalog's
   *  `company-delete` confirm (M27 §5.1) names this alongside the department-template and
   *  catalog-slave counts a deletion would cascade, so an operator sees what survives before it
   *  runs. One `groupBy` in `listRoster`, not a per-company query. */
  readonly projectsUsing: number
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
          slaves: {
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

  const allWorkers = companies.flatMap((c) => c.teams.flatMap((t) => t.slaves.flatMap((a) => a.workers)))
  const workspaceIdBySlave = new Map(allWorkers.map((w) => [w.id, w.team.workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(allWorkers.map((w) => [w.team.workspaceId, w.team.workspace.maxToolCallsPerRun] as const))
  const liveInfo = await loadSlaveLiveInfo(
    allWorkers.map((w) => w.id),
    workspaceIdBySlave,
    maxToolCallsByWorkspace,
  )

  // One grouped query for every company's assigned-project count (M27 §5.1) -- not a per-company
  // `count()` inside the `map` below.
  const projectsUsingGroups = await prisma.workspace.groupBy({ by: ['companyId'], _count: { _all: true } })
  const projectsUsingByCompany = new Map(
    projectsUsingGroups.filter((g) => g.companyId !== null).map((g) => [g.companyId as string, g._count._all] as const),
  )

  return companies.map((company) => ({
    companyId: company.id,
    companyName: company.name,
    projectsUsing: projectsUsingByCompany.get(company.id) ?? 0,
    teams: company.teams.map((team) => ({
      companyTeamId: team.id,
      teamName: team.name,
      members: team.slaves.map((member) => {
        const workers = member.workers.map((worker) => {
          const info = liveInfo.get(worker.id)
          return {
            slaveId: worker.id,
            name: worker.name,
            role: worker.role,
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
          companySlaveId: member.id,
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
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly workspaceId: string
  readonly projectName: string
  readonly status: string
  readonly currentTask: CurrentTask | null
  /** The worker's team name -- the handoff's "department" column. */
  readonly department: string
  /** The worker's own project `Team.id` (M25 Task 6) -- the department select's current value on
   *  a project row, and the id `PUT /api/slaves/:id/team` moves it away from. */
  readonly teamId: string
  /**
   * The worker's LIVE run's provider, `null` with no live run (the `SlaveCardData.provider` rule,
   * verbatim: a runtime is not decided until a run resolves it). A finished run's provider is
   * deliberately NOT read here -- it would keep naming a runtime after the slave went idle.
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
 * Every slave, across every workspace, as the Slaves page's seven-column table (design README
 * §3a.2).
 *
 * NO `companySlaveId` filter (M14 fix wave, ruling on review I4): a slave is any `Slave` row on
 * a workspace's team, and being staffed from a company roster is optional. The old
 * `where: { companySlaveId: { not: null } }` made "worker" mean "roster-linked", which rendered
 * the table as a bare header on any development database whose slaves were created by hand --
 * and disagreed with `listProjects`'s avatar row about how many slaves a project has.
 * `department` is the slave's TEAM name, which every slave has; `companyName` may be null, and
 * that is not a reason to hide a slave from the page that lists slaves.
 *
 * Hides an archived project's slaves by default (M27 §3.3) -- `options?.includeArchived` is
 * threaded through from `listAllSlaves`, which is the Slaves page's own read.
 */
export async function listWorkers(options?: { readonly includeArchived?: boolean }): Promise<readonly WorkerRow[]> {
  const slaves = await prisma.slave.findMany({
    where: { team: { workspace: notArchived(options?.includeArchived) } },
    orderBy: { name: 'asc' },
    include: { team: { include: { workspace: true } } },
  })
  const slaveIds = slaves.map((a) => a.id)

  const workspaceIdBySlave = new Map(slaves.map((a) => [a.id, a.team.workspaceId] as const))
  const maxToolCallsByWorkspace = new Map(slaves.map((a) => [a.team.workspaceId, a.team.workspace.maxToolCallsPerRun] as const))

  const [liveInfo, runGroups, liveRuns] = await Promise.all([
    loadSlaveLiveInfo(slaveIds, workspaceIdBySlave, maxToolCallsByWorkspace),
    // Grouped by the database (M19 Task 12; the same move `listProjects`' spend groups made in M17
    // Task 13), now also carrying `tokensIn`/`tokensOut` so `tokens` can be summed without pulling
    // every run into memory. `_count.tokensIn`/`_count.tokensOut` count only the bucket's non-null
    // values -- exactly what `tokens`'s null rule needs: a bucket where NEITHER column was ever
    // reported still has a `_sum` of `null` (indistinguishable from "summed to zero"), so the count
    // beside it is what tells the two apart.
    prisma.slaveRun.groupBy({
      by: ['slaveId', 'provider', 'status'],
      where: { slaveId: { in: slaveIds } },
      _sum: { costUsd: true, tokensIn: true, tokensOut: true },
      _count: { _all: true, costUsd: true, tokensIn: true, tokensOut: true },
    }),
    // The live provider, as a SEPARATE bounded query rather than read off the grouped rows above --
    // `groupBy` can only aggregate a bucket, never return "the newest row in it". In-flight runs
    // are few by construction (at most one non-terminal run per slave in the steady state), so this
    // stays cheap while preserving today's newest-first pick exactly.
    prisma.slaveRun.findMany({
      where: { slaveId: { in: slaveIds }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
      select: { slaveId: true, provider: true, startedAt: true },
      orderBy: { startedAt: 'desc' },
    }),
  ])

  // Same `SpendGroup` construction as `listProjects` above, keyed by slave instead of workspace.
  // `tokenTotalsBySlave` is `spendGroupsBySlave`'s token-side twin: `sum` accumulates unconditionally
  // (a group nobody reported tokens in has a `_sum` of `null`, so `?? 0` contributes nothing),
  // `reported` is set the moment ANY group of the slave shows a non-zero token count -- the null
  // rule is about whether the slave EVER reported, not whether any one bucket did.
  const spendGroupsBySlave = new Map<string, SpendGroup[]>()
  const tokenTotalsBySlave = new Map<string, { sum: number; reported: boolean }>()
  for (const g of runGroups) {
    const spendGroup: SpendGroup = {
      provider: g.provider,
      status: g.status,
      knownUsd: g._sum.costUsd ?? 0,
      rowCount: g._count._all,
      measuredCount: g._count.costUsd,
    }
    const spendList = spendGroupsBySlave.get(g.slaveId)
    if (spendList === undefined) spendGroupsBySlave.set(g.slaveId, [spendGroup])
    else spendList.push(spendGroup)

    const totals = tokenTotalsBySlave.get(g.slaveId) ?? { sum: 0, reported: false }
    totals.sum += (g._sum.tokensIn ?? 0) + (g._sum.tokensOut ?? 0)
    if (g._count.tokensIn > 0 || g._count.tokensOut > 0) totals.reported = true
    tokenTotalsBySlave.set(g.slaveId, totals)
  }

  // First row per slave wins -- `liveRuns` is ordered newest-first, so this is the newer of an
  // slave's non-terminal runs when it has more than one. (Review Minor: `orderBy` here is a single
  // key, `startedAt` -- two non-terminal runs of the same slave with an EXACTLY equal `startedAt`
  // tie-break in whatever order Postgres returns them, which is unspecified. Pre-existing: the
  // prior whole-history `findMany` this replaced ordered by the same single `startedAt` key.)
  const liveProviderBySlave = new Map<string, (typeof liveRuns)[number]['provider']>()
  for (const run of liveRuns) {
    if (!liveProviderBySlave.has(run.slaveId)) liveProviderBySlave.set(run.slaveId, run.provider)
  }

  return slaves.map((slave) => {
    const info = liveInfo.get(slave.id)
    const liveProvider = liveProviderBySlave.get(slave.id) ?? null
    const { spend, unmeasuredRuns } = spendOfGroups(spendGroupsBySlave.get(slave.id) ?? [])
    const tokenTotals = tokenTotalsBySlave.get(slave.id)
    return {
      slaveId: slave.id,
      name: slave.name,
      role: slave.role,
      workspaceId: slave.team.workspaceId,
      projectName: slave.team.workspace.name,
      status: info?.status ?? 'idle',
      currentTask: info?.currentTask ?? null,
      department: slave.team.name,
      teamId: slave.teamId,
      provider: liveProvider,
      gate: liveProvider === null ? null : capabilitiesOf(liveProvider).gate,
      tokens: tokenTotals === undefined || !tokenTotals.reported ? null : tokenTotals.sum,
      costUsd: spend,
      unmeasuredRuns,
    }
  })
}

/** `AllSlaveRow` (M24 §5.3): one row for every slave, whether a project has materialized it or
 *  not. `slaveId`/`companySlaveId` are the two identities `listWorkers`/`listRoster` each carry
 *  half of -- `null` for `slaveId` marks a catalog member no project has materialized yet, and
 *  `null` for `companySlaveId` marks a slave with no roster link at all (a hand-made worker, or
 *  a worker whose roster row has since been deleted -- the same `Slave.companySlaveId` nullable
 *  column `listWorkers`'s own docstring explains). */
export interface AllSlaveRow {
  /** `null` for a catalog member no project has materialized yet. */
  readonly slaveId: string | null
  readonly companySlaveId: string | null
  readonly name: string
  readonly role: string
  /** The row's department name -- a project row's `Team.name`, or a catalog row's
   *  `CompanyTeam.name` (M25 Task 6: was `teamName`, renamed once the Slaves table's department
   *  column became a `<select>` that reads/writes the department, not just names it). */
  readonly departmentName: string
  readonly projectName: string | null
  readonly workspaceId: string | null
  /** A project row's own `Team.id` -- the department select's current value, and the id
   *  `PUT /api/slaves/:id/team` moves it away from. `null` for a catalog row, which has no
   *  project team at all. */
  readonly teamId: string | null
  /** The company this slave is roster-linked to, whether the row is a project row (roster-linked
   *  via `companySlaveId`) or a catalog row (every catalog row lives on a company). `null` for a
   *  hand-made project slave with no roster link at all. Keys `AllSlavesPage.templatesByCompany`. */
  readonly companyId: string | null
  /** A catalog row's own `CompanyTeam.id` -- the department select's current value on a catalog
   *  row, and the id `PUT /api/org/slaves/:id/team` moves it away from. `null` for a project row
   *  (materialized or not): a project row's department select reads/writes `teamId` instead. */
  readonly companyTeamId: string | null
  readonly status: string
  readonly currentTask: CurrentTask | null
  readonly provider: ProviderKind | null
  readonly gate: WorkerGate | null
  /** The slave's own `Slave.model` column for a project row (fix round 1, Important finding 2:
   *  every project row, roster-linked or not -- a hand-made slave's own override is a real fact,
   *  not a gap this table papers over with `null`); `RosterMemberRow.effectiveModel`'s chain
   *  result (roster row, then template default) for a catalog row, which has no `Slave` row of
   *  its own to read a `model` column off. */
  readonly model: string | null
  readonly costUsd: number
  readonly unmeasuredRuns: number
  /** Every run this slave has ever had, live or finished; `0` for a catalog row that has no
   *  materialized slave to have run anything (M27 §4.3's delete confirm: "deletes Alex and 14
   *  runs of history" reads this straight off the row -- `AllSlavesTable`'s poll merge leaves it
   *  as it was rather than re-deriving it on every poll tick; it is refreshed on the next
   *  `router.refresh()`/reload). */
  readonly runCount: number
}

/** One selectable department: a project `Team`, or a catalog `CompanyTeam` (M25 Task 6). The
 *  Slaves table's department `<select>` renders a list of these -- `id` is the value it PUTs. */
export interface DepartmentOption {
  readonly id: string
  readonly name: string
}

/** `listAllSlaves()`'s full return shape (M25 Task 6, spec §4.1): the row union, plus the two
 *  option lists the department select needs -- a project row's own workspace's departments, and
 *  a catalog row's own company's templates (its `CompanyTeam`s). Keyed by `workspaceId`/
 *  `companyId` so a row picks its own list with no per-row query: one `Team.findMany` and one
 *  `CompanyTeam.findMany`, each grouped once, cover every row on the page. */
export interface AllSlavesPage {
  readonly rows: readonly AllSlaveRow[]
  readonly departmentsByWorkspace: Readonly<Record<string, readonly DepartmentOption[]>>
  readonly templatesByCompany: Readonly<Record<string, readonly DepartmentOption[]>>
}

/**
 * The Slaves page's one table (M24 §5.3; widened to a page object in M25 Task 6, spec §4.1):
 * every project slave (`listWorkers`) plus every catalog member no project has materialized yet
 * (`listRoster`'s members with no workers), plus the department select's two option lists. The
 * two row-source lists are the inputs on purpose -- one place derives a worker's live status, one
 * place walks the model/provider chain -- and this only lines their rows up.
 *
 * `model` on a project row is read directly off `Slave.model` (fix round 1, Important finding 2)
 * rather than through the roster loop below -- the roster loop only reaches a worker that is
 * roster-linked (`member.workers`), so a hand-made slave (`companySlaveId: null`) used to keep
 * `model: null` regardless of its own real override, silently telling `ModelOverrideEditor` no
 * override was set when one was. `listWorkers()`/`listRoster()` both already load a worker's
 * `Slave` row for other reasons, but neither DTO exposes its raw `model` column (`WorkerRow` has
 * no `model` field at all; `RosterMemberRow.workers[].model` exists but only for a roster-linked
 * worker) -- so this queries it directly rather than widening either of those two shapes for one
 * field only this table reads.
 *
 * `departmentsByWorkspace`/`templatesByCompany` are each ONE query, grouped once here rather than
 * fetched per row -- `DepartmentCell` (`AllSlavesTable.tsx`) picks its own row's list straight out
 * of the map by `workspaceId`/`companyId`, with no round trip of its own.
 *
 * `runCount` (M27 §7) is its own `slaveRun.groupBy` by `slaveId` alone -- `listWorkers`'s own
 * grouped query already buckets by `slaveId`/`provider`/`status` for `costUsd`/`unmeasuredRuns`,
 * so a bucket's row count there is a PARTIAL count, not the total; this is the same "query it
 * directly" call the `model` column above already made, for the same reason.
 */
export async function listAllSlaves(options?: { readonly includeArchived?: boolean }): Promise<AllSlavesPage> {
  const [workers, roster] = await Promise.all([listWorkers(options), listRoster()])
  const [slaveModels, runCounts, teams, companyTeams] = await Promise.all([
    prisma.slave.findMany({
      where: { id: { in: workers.map((w) => w.slaveId) } },
      select: { id: true, model: true },
    }),
    prisma.slaveRun.groupBy({ by: ['slaveId'], where: { slaveId: { in: workers.map((w) => w.slaveId) } }, _count: { _all: true } }),
    prisma.team.findMany({ select: { id: true, name: true, workspaceId: true }, orderBy: { name: 'asc' } }),
    prisma.companyTeam.findMany({ select: { id: true, name: true, companyId: true }, orderBy: { name: 'asc' } }),
  ])
  const modelBySlaveId = new Map(slaveModels.map((a) => [a.id, a.model] as const))
  const runCountBySlaveId = new Map(runCounts.map((g) => [g.slaveId, g._count._all] as const))
  const departmentsByWorkspace: Record<string, DepartmentOption[]> = {}
  for (const t of teams) (departmentsByWorkspace[t.workspaceId] ??= []).push({ id: t.id, name: t.name })
  const templatesByCompany: Record<string, DepartmentOption[]> = {}
  for (const t of companyTeams) (templatesByCompany[t.companyId] ??= []).push({ id: t.id, name: t.name })

  const workerRows: AllSlaveRow[] = workers.map((w) => ({
    slaveId: w.slaveId,
    companySlaveId: null, // filled below from the roster when the worker is roster-linked
    name: w.name,
    role: w.role,
    departmentName: w.department,
    projectName: w.projectName,
    workspaceId: w.workspaceId,
    teamId: w.teamId,
    companyId: null, // filled below from the roster when the worker is roster-linked
    companyTeamId: null,
    status: w.status,
    currentTask: w.currentTask,
    provider: w.provider,
    gate: w.gate,
    model: modelBySlaveId.get(w.slaveId) ?? null,
    costUsd: w.costUsd,
    unmeasuredRuns: w.unmeasuredRuns,
    runCount: runCountBySlaveId.get(w.slaveId) ?? 0,
  }))
  const bySlaveId = new Map(workerRows.map((r) => [r.slaveId, r] as const))
  // A catalog member's row (fix round 1, Important finding 1): built once, used both when the
  // member has never been materialized at all AND when every worker it WAS materialized into
  // belongs to a project this read is currently hiding (an archived project, unless
  // `includeArchived` was passed). Without the second case, a slave whose only project went
  // archived produced neither a project row (filtered by `listWorkers`) nor a catalog row (its
  // `member.workers.length` is not `0`), vanishing from the table entirely -- including its
  // `catalog-slave-delete` action, which this table is the only place that offers it.
  const catalogRowFor = (
    company: (typeof roster)[number],
    team: (typeof roster)[number]['teams'][number],
    member: (typeof roster)[number]['teams'][number]['members'][number],
  ): AllSlaveRow => ({
    slaveId: null, companySlaveId: member.companySlaveId, name: member.name, role: member.role,
    departmentName: team.teamName, projectName: null, workspaceId: null,
    teamId: null, companyId: company.companyId, companyTeamId: team.companyTeamId,
    status: 'idle', currentTask: null,
    provider: member.effectiveProvider,
    gate: member.effectiveProvider === null ? null : capabilitiesOf(member.effectiveProvider).gate,
    model: member.effectiveModel, costUsd: 0, unmeasuredRuns: 0, runCount: 0,
  })
  const catalogRows: AllSlaveRow[] = []
  for (const company of roster) {
    for (const team of company.teams) {
      for (const member of team.members) {
        if (member.workers.length === 0) {
          catalogRows.push(catalogRowFor(company, team, member))
          continue
        }
        let anyResolved = false
        for (const worker of member.workers) {
          const row = bySlaveId.get(worker.slaveId)
          if (row === undefined) continue
          anyResolved = true
          bySlaveId.set(worker.slaveId, { ...row, companySlaveId: member.companySlaveId, companyId: company.companyId })
        }
        if (!anyResolved) catalogRows.push(catalogRowFor(company, team, member))
      }
    }
  }
  const projectRows = [...bySlaveId.values()].sort((a, b) => (a.projectName ?? '').localeCompare(b.projectName ?? '') || a.name.localeCompare(b.name))
  catalogRows.sort((a, b) => a.name.localeCompare(b.name))
  return { rows: [...projectRows, ...catalogRows], departmentsByWorkspace, templatesByCompany }
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
  const templates = await prisma.slaveTemplate.findMany({
    select: { id: true, name: true, role: true, description: true, defaultModel: true, provider: true },
    orderBy: { name: 'asc' },
  })
  return templates.map(({ provider, ...rest }) => ({ ...rest, defaultProvider: provider }))
}

export async function listCompanies(): Promise<readonly { id: string; name: string }[]> {
  return prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}

/** One project `Team` row for the Slaves page's Departments tab (M23 D3; renamed M25 §4.2).
 *  `slaveCount` is display only now (M27 §4.2): `deleteTeam` no longer refuses a non-empty team --
 *  it deletes the department WITH its slaves, refused only while one of them holds a live run.
 *  `runCount` is `DepartmentsTable`'s delete confirm text: "deletes Engineering: 4 slaves, 31
 *  runs" (M27 §4.3). */
export interface ProjectTeamRow {
  readonly teamId: string
  readonly name: string
  readonly workspaceId: string
  readonly projectName: string
  readonly slaveCount: number
  readonly runCount: number
}

/**
 * Every project TEAM, across every workspace (the `Team` row `renameTeam`/`deleteTeam` address)
 * -- ordered project then name, so a multi-project install reads as grouped even though
 * `DepartmentsTable` renders one flat `DataTable`. Hides an archived project's teams by default
 * (M27 §3.3).
 */
export async function listProjectTeams(options?: { readonly includeArchived?: boolean }): Promise<readonly ProjectTeamRow[]> {
  const teams = await prisma.team.findMany({
    where: { workspace: notArchived(options?.includeArchived) },
    include: { workspace: { select: { name: true } }, _count: { select: { slaves: true } } },
    orderBy: [{ workspace: { name: 'asc' } }, { name: 'asc' }],
  })
  // `runCount` per team (M27 §7): teams don't own a run directly, so this walks `Slave.teamId`
  // then sums a `slaveRun.groupBy` by `slaveId` per team -- two bulk queries across every team,
  // not one query per row.
  const teamIds = teams.map((t) => t.id)
  const slaves = await prisma.slave.findMany({ where: { teamId: { in: teamIds } }, select: { id: true, teamId: true } })
  const teamBySlave = new Map(slaves.map((s) => [s.id, s.teamId] as const))
  const runGroups = await prisma.slaveRun.groupBy({
    by: ['slaveId'],
    where: { slaveId: { in: slaves.map((s) => s.id) } },
    _count: { _all: true },
  })
  const runCountByTeam = new Map<string, number>()
  for (const g of runGroups) {
    const teamId = teamBySlave.get(g.slaveId)
    if (teamId === undefined) continue
    runCountByTeam.set(teamId, (runCountByTeam.get(teamId) ?? 0) + g._count._all)
  }
  return teams.map((team) => ({
    teamId: team.id,
    name: team.name,
    workspaceId: team.workspaceId,
    projectName: team.workspace.name,
    slaveCount: team._count.slaves,
    runCount: runCountByTeam.get(team.id) ?? 0,
  }))
}
