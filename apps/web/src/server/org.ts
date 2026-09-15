import { prisma } from '@slave-of-ai/db/client'
import { toRunState } from '@slave-of-ai/db'
import {
  capabilitiesOf,
  listCapabilities,
  listCatalogImports as listCatalogImportRows,
  listRunbooks,
  listTemplateDuplicates,
  listWorkforceCatalog,
  readTemplateProfile,
  TEMPLATE_PICKER_MAX,
  type ControlRefusal,
  type ProviderCapabilities,
  type ProviderKind,
  type RunbookView,
  type TemplateDuplicateView,
  type TemplateProfileView,
  type WorkforceCatalogFacets,
  type WorkforceCatalogFilters,
  type WorkforceCatalogRow,
} from '@slave-of-ai/control'
import {
  deriveSlaveStatus,
  needsYou,
  sumSpendFromGroups,
  NON_TERMINAL_RUN_STATUSES,
  SUPERVISOR_PER_CALL_CAP_USD,
  type BreakerLevel,
  type CapabilityRecord,
  type DuplicateCounts,
  type Result,
  type SlaveLifecycle,
  type SlaveStatus,
  type SpendGroup,
  type TaskStatus,
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
// the merge queue is still active work; the M36 t2 one: a task waiting for another slave's answer
// is in flight, not parked for a human). Not imported from there -- overview.ts does not export
// it, and this task's scope is one new module, nothing else changes.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const

/** Every list read below's default filter (M27 §3.3): an archived project has `archivedAt !==
 *  null` and is hidden from every list unless a caller opts in with `includeArchived: true`
 *  (the Projects page's `show archived` toggle is the one caller that does -- every other read
 *  keeps the default). A bare `{}` puts no constraint on `archivedAt` at all, rather than an
 *  `{ archivedAt: { not: null } }` that would flip the toggle into an archived-ONLY view nothing
 *  asks for. */
const notArchived = (includeArchived?: boolean): { archivedAt?: null } => (includeArchived === true ? {} : { archivedAt: null })

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
  /**
   * KNOWN spend: every run of this project that reported a cost, plus what its SUPERVISOR's model
   * calls cost (M39 §4) -- a measured call at its recorded cost, a call that was made and reported
   * nothing at `SUPERVISOR_PER_CALL_CAP_USD`, exactly as `workspaceSpend`
   * (`packages/control/src/spend.ts`) charges them for the budget guardrail. The SAME number the
   * overview's bar, the shell and the guardrail read, because a project that looks cheaper on this
   * list than it does on its own page is a list nobody can act on.
   */
  readonly spend: number
  /**
   * How many of this project's runs actually ran, finished, and left no cost figure behind (M12
   * Task 9, ruling R3; corrected in fix round F1). Rendered as its own stat rather than folded
   * into `spend`, because a total that silently absorbs unmeasured runs as zeros presents the
   * measured part of a bill as the whole of it. NOT the count of null `costUsd` columns --
   * `sumSpend` holds the rule.
   */
  readonly unmeasuredRuns: number
  /**
   * How many of this project's tasks need a PERSON before they move (M44 R1/R4, E19), counted here
   * so the Projects home does not have to fetch a board per card.
   *
   * DERIVED THROUGH THE PROJECTION, not restated: every status group is put through the domain's
   * own `needsYou(...)` (fix wave, review item I1). The old arithmetic spelled two of that
   * function's clauses out here as `blocked + un-integrated done`, which read the same on the day
   * it was written and was a second place for the rule to live -- a fourth clause, or a change to
   * one of the three, would have moved one of the two copies and not the other.
   *
   * Three of the four clauses are answerable from grouped counts: `blocked`, `done` with
   * `integratedAt: null` against the workspace's own `autoMerge`, and a `pending`
   * `SupervisorDecision` (one grouped read below). The fourth -- a `waiting` task whose question
   * nobody can answer (M39's unanswerable case) -- is a per-task join that is NOT made here;
   * M45's needs-you queue is where a task-level read of this belongs. `docs/ia.md` records what
   * the number does and does not contain, so nobody reads it as a total.
   */
  readonly needsYou: number
}

/** Every project (M27 §3.3, §7): hides an archived project by default -- `options?.includeArchived`
 *  is the Projects page's `show archived` toggle, the one caller that passes `true`. */
export async function listProjects(options?: { readonly includeArchived?: boolean }): Promise<readonly ProjectRow[]> {
  // `teams: { include: { slaves: true } }` -- the avatar row's source. One join, not a
  // per-project query: every workspace's team roster comes back in this same round trip.
  const workspaces = await prisma.workspace.findMany({
    where: notArchived(options?.includeArchived),
    // M58 R17: OPEN seats only -- the avatar row shows who is on this project now, and a closed
    // seat is somebody who was.
    include: { company: true, teams: { include: { slaves: { where: { closedAt: null }, include: { person: { select: { name: true } } } } } } },
    orderBy: { name: 'asc' },
  })

  const [taskGroups, unintegratedDoneGroups, slaveRows, spendGroups, decisionGroups, pendingDecisionGroups] = await Promise.all([
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // The second half of `needsYou` (M44 R1): finished work sitting on a branch nothing will merge
    // by itself. `integratedAt` is not a `by` column and cannot be counted out of the group above,
    // so this is its own grouped read -- ONE query for every project, in the same pre-pass, rather
    // than a query per card.
    prisma.task.groupBy({ by: ['workspaceId'], where: { status: 'done', integratedAt: null }, _count: { _all: true } }),
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
    // ONE query for EVERY project's Supervisor spend, not one per project (M39 §4): `workspaceId`
    // is a real column on `SupervisorDecision` (unlike a run's, which has to be resolved through
    // its slave's team above), so the database groups the whole list in a single round trip.
    // `modelCalled` is the second `by` column because it is the predicate the unmeasured charge
    // keys on, and `_count._all` minus `_count.modelCostUsd` (Prisma counts NON-NULL values for a
    // named field) is that tally without a second read -- `workspaceSpend`'s own idiom, kept
    // identical so the two cannot drift.
    prisma.supervisorDecision.groupBy({
      by: ['workspaceId', 'modelCalled'],
      _sum: { modelCostUsd: true },
      _count: { _all: true, modelCostUsd: true },
    }),
    // `needsYou`'s third clause (E19): a proposal the Supervisor put in front of a human. ONE
    // grouped read for every project, in the same pre-pass as the four above -- the spend group
    // beside it cannot answer this, because it groups by `modelCalled` and carries no `status`.
    //
    // It counts DECISIONS, not the tasks they are about, and that is the honest number rather
    // than the convenient one: `SupervisorDecision` has no task column at all. Its `subjectId` is
    // a task id, a message id, a role name OR the workspace's own id depending on
    // `situationKind`, so "tasks with a pending decision" is not derivable from this table
    // without knowing which kinds are task-shaped -- and half of the pending decisions a person
    // has to answer are about no task whatsoever (`ready_unstaffed` is about a ROLE). Counting
    // rows never claims a task needs a person that does not; it can only overlap with the two
    // task clauses, and `recordDecision` keeps at most one open decision per situation key, so
    // it does not double-count one question either. `docs/ia.md` says which number this is.
    prisma.supervisorDecision.groupBy({
      by: ['workspaceId'],
      where: { status: 'pending' },
      _count: { _all: true },
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

  // `workspaceSpend`'s formula, merged per workspace out of the one grouped read above. Summed
  // across BOTH `modelCalled` groups for the same reason it is there: a row that says no call was
  // made should carry no cost, and money that was somehow recorded on one belongs in the total
  // rather than filtered out of it.
  const supervisorByWorkspace = new Map<string, { measuredUsd: number; unmeasuredCalls: number }>()
  for (const group of decisionGroups) {
    const running = supervisorByWorkspace.get(group.workspaceId) ?? { measuredUsd: 0, unmeasuredCalls: 0 }
    running.measuredUsd += group._sum.modelCostUsd ?? 0
    if (group.modelCalled) running.unmeasuredCalls += group._count._all - group._count.modelCostUsd
    supervisorByWorkspace.set(group.workspaceId, running)
  }

  /** One project's two spend figures. `spend` is the whole workspace's money -- runs and Supervisor
   *  together, `workspaceSpend`'s `spentUsd`. `unmeasuredRuns` stays a count of RUNS: a Supervisor
   *  call nobody measured is already IN the total at the cap, and counting it here as well would
   *  answer a question this stat does not ask. */
  const spendOf = (workspaceId: string): { readonly spend: number; readonly unmeasuredRuns: number } => {
    const runs = spendOfGroups(groupsByWorkspace.get(workspaceId) ?? [])
    const supervisor = supervisorByWorkspace.get(workspaceId) ?? { measuredUsd: 0, unmeasuredCalls: 0 }
    return {
      spend: runs.spend + supervisor.measuredUsd + supervisor.unmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
      unmeasuredRuns: runs.unmeasuredRuns,
    }
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
  const unintegratedDoneOf = (workspaceId: string): number =>
    unintegratedDoneGroups.find((g) => g.workspaceId === workspaceId)?._count._all ?? 0
  const pendingDecisionsOf = (workspaceId: string): number =>
    pendingDecisionGroups.find((g) => g.workspaceId === workspaceId)?._count._all ?? 0

  /**
   * `needsYou`, THROUGH the domain's own projection (review item I1) rather than restated here.
   *
   * Every status group is put to `needsYou({ status, autoMerge, integrated })` and contributes its
   * whole count when the answer is true, so this function's arithmetic cannot disagree with the
   * word a task's own pill reads. `done` is the one group that has to be split: `integratedAt` is
   * not a `by` column, so the group carries integrated and un-integrated work together, and
   * `unintegratedDoneOf` (its own grouped read) separates the two halves -- each then asked
   * SEPARATELY, integrated and not, rather than assumed.
   *
   * `questionHolder` and `decisionPending` are deliberately not passed: neither is a per-task fact
   * any of these grouped reads has. The waiting-on-nobody clause therefore contributes zero (M45),
   * and the pending-decision clause is added on top from its own workspace-level count.
   */
  const needsYouOf = (workspaceId: string, autoMerge: boolean): number => {
    let tasks = 0
    for (const group of taskGroups) {
      if (group.workspaceId !== workspaceId) continue
      const status = group.status as TaskStatus
      if (status === 'done') {
        const unintegrated = unintegratedDoneOf(workspaceId)
        if (needsYou({ status, autoMerge, integrated: false })) tasks += unintegrated
        if (needsYou({ status, autoMerge, integrated: true })) tasks += group._count._all - unintegrated
        continue
      }
      if (needsYou({ status, autoMerge })) tasks += group._count._all
    }
    return tasks + pendingDecisionsOf(workspaceId)
  }

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
      .map((slave) => ({ slaveId: slave.id, name: slave.person.name, status: teamSlaveLiveInfo.get(slave.id)?.status ?? 'idle' })),
    needsYou: needsYouOf(workspace.id, workspace.autoMerge),
    // A workspace with no runs and no decisions at all has spent nothing and has nothing
    // unmeasured -- `sumSpendFromGroups([])` and an absent Supervisor entry both say exactly that.
    ...spendOf(workspace.id),
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
  /** M51 R7: the rung the behavioural breaker has this worker's live run on, `'none'` with no live
   *  run. Derived here, beside the status, so every surface that shows a worker's word reads one
   *  derivation rather than two. */
  readonly breakerLevel: BreakerLevel
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
    const breakerLevel = run?.breakerLevel ?? 'none'
    let currentTask: CurrentTask | null = null
    if (run !== null && run.task !== null) {
      const maxToolCalls = maxToolCallsByWorkspace.get(workspaceIdBySlave.get(slaveId) ?? '') ?? 0
      const pct = maxToolCalls > 0 ? Math.min(100, Math.max(0, Math.round((run.toolCalls / maxToolCalls) * 100))) : 0
      currentTask = { title: run.task.title, pct }
    }
    result.set(slaveId, { status, currentTask, breakerLevel })
  }
  return result
}

export interface RosterMemberRow {
  /** M58 R5: a department holds PEOPLE, so this is the person -- there is no roster row to name. */
  readonly personId: string
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
    /** M58 R2: the seat's own `role` beside the person's name. The name is now the SAME string as
     *  the member's above -- one person, one name across every project -- and `role` is the seat
     *  fact that can differ from the persona's, which is what `SlaveRowActions` edits. */
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
          members: {
            orderBy: { person: { name: 'asc' } },
            include: {
              person: {
                include: {
                  template: true,
                  // M58 R17: the OPEN seats this person holds. A closed one is history and belongs
                  // on no roster.
                  seats: { where: { closedAt: null }, include: { team: { include: { workspace: true } } } },
                },
              },
            },
          },
        },
      },
    },
  })

  const allWorkers = companies.flatMap((c) => c.teams.flatMap((t) => t.members.flatMap((m) => m.person.seats)))
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
      members: team.members.map(({ person: member }) => {
        const workers = member.seats.map((worker) => {
          const info = liveInfo.get(worker.id)
          return {
            slaveId: worker.id,
            name: member.name,
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
          member.template?.defaultModel ?? null,
        )
        const providerSource = chainSource(
          workers.some((w) => w.provider !== null),
          member.provider,
          member.template?.provider ?? null,
        )

        return {
          personId: member.id,
          name: member.name,
          role: member.template?.role ?? '',
          templateName: member.template?.name ?? '',
          // The chain result IGNORING worker overrides -- each worker's own value shows in its
          // sub-row above instead.
          effectiveModel: member.model ?? member.template?.defaultModel ?? null,
          modelSource,
          rosterModel: member.model,
          templateDefaultModel: member.template?.defaultModel ?? null,
          effectiveProvider: member.provider ?? member.template?.provider ?? null,
          providerSource,
          workers,
        }
      }),
    })),
  }))
}

export interface WorkerRow {
  readonly slaveId: string
  /** M58 R2: the person sitting in this seat -- what every person-scoped verb is addressed by. */
  readonly personId: string
  readonly name: string
  readonly role: string
  /**
   * The roles this worker may be DISPATCHED as (M37 §5) -- what the scheduler, reviewer/manager
   * staffing and role-addressed messaging match on, while `role` above is the profile's title and
   * is matched by nothing.
   *
   * An empty array is a real state, not missing data: the worker is parked and can never be
   * picked (spec §7), which is what the Slaves table warns about.
   */
  readonly runtimeRoles: readonly string[]
  readonly workspaceId: string
  readonly projectName: string
  readonly status: string
  /** M51 R7: the rung the breaker has this worker's live run on -- polled with `status` and for the
   *  same reason, so a steered run reaches the Slaves table within one tick. */
  readonly breakerLevel: BreakerLevel
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
  /** M50 R1: WHY this worker is here, off `Person.lifecycle` (M58 R1). A column, never a
   *  derivation. */
  readonly lifecycle: SlaveLifecycle
  /** M50 R3: the engagement is over. `at` is an ISO string -- this row is serialised straight into
   *  `GET /api/org/workers`' poll payload -- and `reason` is the sentence it ended with. */
  readonly released: { readonly at: string; readonly reason: string } | null
  /** `tokensIn + tokensOut` summed over this worker's runs that reported them; `null` when none
   *  did (M14 Decision 4 -- Cursor reports none, and `0` would be a claim). */
  readonly tokens: number | null
  /** KNOWN spend across this worker's runs. */
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

/**
 * Every OPEN SEAT, across every workspace, as the Slaves page's seven-column table (design README
 * §3a.2).
 *
 * NO department filter (M14 fix wave, ruling on review I4): a row here is any open seat on a
 * workspace's team, and belonging to a company department is optional. Filtering on the roster link
 * made "worker" mean "roster-linked", which rendered the table as a bare header on any development
 * database whose slaves were created by hand -- and disagreed with `listProjects`'s avatar row about
 * how many slaves a project has. `department` is the seat's TEAM name, which every seat has;
 * `companyName` may be null, and that is not a reason to hide somebody from the page that lists
 * slaves.
 *
 * Hides an archived project's slaves by default (M27 §3.3) -- `options?.includeArchived` is
 * threaded through from `listAllSlaves`, which is the Slaves page's own read.
 */
export async function listWorkers(options?: { readonly includeArchived?: boolean }): Promise<readonly WorkerRow[]> {
  const slaves = await prisma.slave.findMany({
    // M58 R17: OPEN seats only. A closed seat keeps its history and is nobody's row on this page.
    where: { closedAt: null, team: { workspace: notArchived(options?.includeArchived) } },
    orderBy: { person: { name: 'asc' } },
    include: { person: true, team: { include: { workspace: true } } },
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
      personId: slave.personId,
      name: slave.person.name,
      role: slave.role,
      runtimeRoles: slave.runtimeRoles,
      lifecycle: slave.person.lifecycle,
      released:
        slave.person.releasedAt === null
          ? null
          : { at: slave.person.releasedAt.toISOString(), reason: slave.person.releaseReason ?? 'released' },
      workspaceId: slave.team.workspaceId,
      projectName: slave.team.workspace.name,
      status: info?.status ?? 'idle',
      breakerLevel: info?.breakerLevel ?? 'none',
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

/** `AllSlaveRow` (M24 §5.3): one row for every slave -- whether or not a project has a seat for
 *  them. M58 R2 splits the two identities cleanly: `personId` is always there, because a row is a
 *  PERSON, and `slaveId` is `null` for somebody in the POOL, who holds no open seat anywhere. */
export interface AllSlaveRow {
  /** `null` for somebody in the pool -- they work here and hold no open seat (M58 R16). */
  readonly slaveId: string | null
  readonly personId: string
  readonly name: string
  readonly role: string
  /**
   * `WorkerRow.runtimeRoles` for a project row (M37 t4 fix round 1).
   *
   * ALWAYS empty on a POOL row, and it means something different there: somebody with no open seat
   * has no dispatch set to be parked out of -- which is why `AllSlavesTable` renders the parked
   * warning only for a row that has a `slaveId`. The field is not nullable, because "no seat" is
   * already said by `slaveId === null` and a second way of saying it is a second thing to keep in
   * step.
   */
  readonly runtimeRoles: readonly string[]
  /** M50 R1: WHY this row is here -- the Slaves table's own Lifecycle column, off
   *  `Person.lifecycle` (M58 R1). One column for a seated row and a pooled one alike, which is
   *  what moving it to the person bought. Merged on every poll tick like `status`, not fixed at
   *  load (plan decision D6): an approved hire lands between reloads. */
  readonly lifecycle: SlaveLifecycle
  /** M50 R3: the engagement is over -- `at` is an ISO string (this row is serialised into the
   *  poll payload) and `reason` is the sentence the release was recorded with. `null` for
   *  everybody still here. The table greys a released row rather than dropping it (D7). */
  readonly released: { readonly at: string; readonly reason: string } | null
  /** The row's department name -- a seated row's `Team.name`, or a pooled row's `CompanyTeam.name`
   *  (M25 Task 6: was `teamName`, renamed once the Slaves table's department column became a
   *  `<select>` that reads/writes the department, not just names it). */
  readonly departmentName: string
  readonly projectName: string | null
  readonly workspaceId: string | null
  /** A seated row's own `Team.id` -- the department select's current value, and the id
   *  `PUT /api/slaves/:id/team` moves it away from. `null` for a pooled row, which sits on no
   *  project team at all. */
  readonly teamId: string | null
  /** The company whose department this person belongs to (M58 R5), whether they hold a seat or
   *  not. `null` for somebody in no department at all. Keys `AllSlavesPage.templatesByCompany`. */
  readonly companyId: string | null
  /** A pooled row's own `CompanyTeam.id` -- the department select's current value there, and the
   *  id `PUT /api/org/slaves/:id/team` moves it away from. `null` for a seated row, whose
   *  department select reads/writes `teamId` instead. */
  readonly companyTeamId: string | null
  readonly status: string
  /** M51 R7: the rung the breaker has this row's live run on; `'none'` for an idle worker AND for
   *  every catalog row, which has no `Slave` -- and so no run -- to read a column off. Merged on
   *  every poll tick like `status`. */
  readonly breakerLevel: BreakerLevel
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
 * every OPEN SEAT (`listWorkers`) plus everybody in the POOL -- who works here and holds no open
 * seat anywhere (M58 R16) -- plus the department select's two option lists. The row sources are the
 * inputs on purpose -- one place derives a worker's live status, one place walks the model/provider
 * chain -- and this only lines their rows up.
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
    personId: w.personId,
    name: w.name,
    role: w.role,
    runtimeRoles: w.runtimeRoles,
    lifecycle: w.lifecycle,
    released: w.released,
    departmentName: w.department,
    projectName: w.projectName,
    workspaceId: w.workspaceId,
    teamId: w.teamId,
    companyId: null, // filled below from the roster when the worker is roster-linked
    companyTeamId: null,
    status: w.status,
    breakerLevel: w.breakerLevel,
    currentTask: w.currentTask,
    provider: w.provider,
    gate: w.gate,
    model: modelBySlaveId.get(w.slaveId) ?? null,
    costUsd: w.costUsd,
    unmeasuredRuns: w.unmeasuredRuns,
    runCount: runCountBySlaveId.get(w.slaveId) ?? 0,
  }))
  const bySlaveId = new Map(workerRows.map((r) => [r.slaveId, r] as const))
  // A seated row learns which company's department its person belongs to, so the table can offer
  // the department select the same options `templatesByCompany` keys.
  const departmentOfPerson = new Map<string, { readonly companyId: string; readonly companyTeamId: string }>()
  for (const company of roster) {
    for (const team of company.teams) {
      for (const member of team.members) {
        if (!departmentOfPerson.has(member.personId)) {
          departmentOfPerson.set(member.personId, { companyId: company.companyId, companyTeamId: team.companyTeamId })
        }
      }
    }
  }
  for (const [slaveId, row] of bySlaveId) {
    const department = departmentOfPerson.get(row.personId)
    if (department !== undefined) bySlaveId.set(slaveId, { ...row, companyId: department.companyId })
  }

  // M58 R16: the POOL -- everybody who works here and holds no OPEN seat anywhere. It replaces the
  // "a catalog member no project has materialised" row, and it is strictly wider: somebody hired
  // for a project that has since been archived, or removed from every seat they held, is a person
  // this installation still has and used to vanish from the page that lists them.
  const pooled = await prisma.person.findMany({
    where: { seats: { none: { closedAt: null } } },
    orderBy: { name: 'asc' },
    include: {
      template: { select: { role: true, defaultModel: true, provider: true } },
      departments: { include: { companyTeam: { include: { company: { select: { id: true, name: true } } } } }, orderBy: { companyTeamId: 'asc' }, take: 1 },
    },
  })
  const poolRows: AllSlaveRow[] = pooled.map((person) => {
    const department = person.departments[0]
    const provider = person.provider ?? person.template?.provider ?? null
    return {
      slaveId: null,
      personId: person.id,
      name: person.name,
      role: person.template?.role ?? '',
      // Nobody in the pool has a seat, so nobody has a dispatch set of their own -- see the field's
      // own docstring for why that is `[]` rather than `null`.
      runtimeRoles: [],
      lifecycle: person.lifecycle,
      released:
        person.releasedAt === null
          ? null
          : { at: person.releasedAt.toISOString(), reason: person.releaseReason ?? 'released' },
      departmentName: department?.companyTeam.name ?? '',
      projectName: null,
      workspaceId: null,
      teamId: null,
      companyId: department?.companyTeam.company.id ?? null,
      companyTeamId: department?.companyTeam.id ?? null,
      // Nobody in the pool holds a run, so no breaker can have spoken to them (M51 R7).
      status: 'idle',
      breakerLevel: 'none',
      currentTask: null,
      provider,
      gate: provider === null ? null : capabilitiesOf(provider).gate,
      model: person.model ?? person.template?.defaultModel ?? null,
      costUsd: 0,
      unmeasuredRuns: 0,
      runCount: 0,
    }
  })

  const projectRows = [...bySlaveId.values()].sort((a, b) => (a.projectName ?? '').localeCompare(b.projectName ?? '') || a.name.localeCompare(b.name))
  return { rows: [...projectRows, ...poolRows], departmentsByWorkspace, templatesByCompany }
}

/** One catalog row as a `'use client'` component receives it: `WorkforceCatalogRow` with its TWO
 *  `Date`s turned into ISO strings, `GoalVersionView.createdAt`'s idiom. Every other field is
 *  already JSON, so this is the whole of the crossing. */
export type CatalogRowView = Omit<WorkforceCatalogRow, 'importedAt' | 'activationChangedAt'> & {
  readonly importedAt: string | null
  readonly activationChangedAt: string | null
}

export interface WorkforceCatalogView {
  readonly rows: readonly CatalogRowView[]
  /** Computed over EVERY row, before the filters ran (M46 R6): a menu built from the filtered rows
   *  collapses to the value already chosen, which makes it impossible to change your mind. */
  readonly facets: WorkforceCatalogFacets
  /** M55 R3: every row this filter matches, so the count sentence can say `showing 100 of 312`. */
  readonly total: number
  /** M55 R3: pass back as `?cursor=` for the next page; null when this page is the whole answer. */
  readonly nextCursor: string | null
}

/**
 * The Workforce Catalog page and its route (M46 R6), PAGED by M55 R3.
 *
 * M46 erratum E9 said this was the page's only catalog read -- "`listTemplates()` IS this call's
 * `.rows`" -- and that was true while both were the same unbounded `findMany` plus the same
 * `companySlave.groupBy`. M55 R3 made this one a PAGE of `CATALOG_PAGE_SIZE`, and a page cannot be
 * the list a company is STAFFED FROM: `listTemplates` below is a second read now, with its own
 * bound and no filters (erratum E2), and `workforce/page.tsx` takes it on every load. What E9 was
 * protecting against -- two identical whole-table reads for one page -- no longer exists to be
 * protected against, because neither of these two reads is that any more.
 */
export async function listWorkforceCatalogPage(
  filters: WorkforceCatalogFilters = {},
  options: { readonly cursor?: string } = {},
): Promise<WorkforceCatalogView> {
  const page = await listWorkforceCatalog(filters, options)
  return {
    rows: page.rows.map(catalogRowViewOf),
    facets: page.facets,
    total: page.total,
    nextCursor: page.nextCursor,
  }
}

/** The `Date` -> ISO crossing, in ONE place: both this page and the unpaged picker read below hand
 *  the same rows to the same `'use client'` components, and two copies of the conversion is how one
 *  of them ends up missing the next column that carries a date. */
function catalogRowViewOf(row: WorkforceCatalogRow): CatalogRowView {
  return {
    ...row,
    importedAt: row.importedAt === null ? null : row.importedAt.toISOString(),
    activationChangedAt: row.activationChangedAt === null ? null : row.activationChangedAt.toISOString(),
  }
}

/** Every slave template, UNPAGED and unfiltered -- the shape `CompanyManager`'s member `<select>`,
 *  the New slave drawer and `company/TeamBlock` take, `catalogSlaveCount` (M27 §5.1) included: how
 *  many catalog slaves a `deleteSlaveTemplate` on this row would cascade.
 *
 *  M55 plan erratum E2: this deliberately does NOT take `CATALOG_PAGE_SIZE`. These are the pickers a
 *  company is STAFFED FROM, and a hundred-row page under them would silently hide every template
 *  past the hundredth from every one of them. `TEMPLATE_PICKER_MAX` is the bound instead --
 *  `CATALOG_ENTRIES_MAX`'s own number -- and it deliberately does not filter on `active` either:
 *  R2 keeps every manual hire open on an inactive row, and a picker that hid them would close the
 *  one path R2 exists to keep open.
 *
 *  `facets: false` (final wave, minor 2): a `<select>` draws no filter menu, and this read sits
 *  BESIDE `listWorkforceCatalogPage`'s on the same page load -- so the three unfiltered facet scans
 *  were running twice for one render of `/workforce`. */
export async function listTemplates(): Promise<readonly CatalogRowView[]> {
  const page = await listWorkforceCatalog({}, { pageSize: TEMPLATE_PICKER_MAX, facets: false })
  return page.rows.map(catalogRowViewOf)
}

/** One runbook as the Workforce tab reads it (M48 R7): the whole runbook, plus the NAME of the
 *  specialist a `persona` one was translated from. The name and not the id, because the drawer says
 *  where a process came from and an id says nothing to the person reading it (`docs/ia.md` rule 3);
 *  null for a `seed` or `human` runbook, which came from nobody. */
export interface RunbookRowView extends RunbookView {
  readonly sourceTemplateName: string | null
}

/**
 * Every runbook, key ascending (M48 R7) -- the Workforce tab's rows, under the web's own name for
 * the control verb (the `listCapabilityTaxonomy` idiom, and the reason every loader this page uses
 * goes through this module).
 *
 * ONE extra query, and only when a `persona` runbook exists: the template names are looked up in a
 * single `findMany` over the ids actually present rather than once per row.
 */
export async function listRunbookRows(): Promise<readonly RunbookRowView[]> {
  const rows = await listRunbooks()
  const templateIds = [...new Set(rows.map((row) => row.sourceTemplateId).filter((id): id is string => id !== null))]
  const templates =
    templateIds.length === 0
      ? []
      : await prisma.slaveTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true } })
  const nameById = new Map(templates.map((template) => [template.id, template.name]))
  return rows.map((row) => ({
    ...row,
    // A template deleted since the translation leaves the runbook standing and the name unknown --
    // the row is still a process somebody can follow, and hiding it would lose it.
    sourceTemplateName: row.sourceTemplateId === null ? null : (nameById.get(row.sourceTemplateId) ?? null),
  }))
}

/** One template's whole specialist profile, for the drawer (plan erratum E10): far too much to put
 *  on every catalog row -- three kilobytes times a few hundred templates to draw a table -- and
 *  exactly what one open drawer needs. `template_not_found` is its only refusal, so the route this
 *  backs is a 200 or a 404 and nothing else. */
export async function readTemplateProfileView(
  templateId: string,
): Promise<Result<TemplateProfileView, ControlRefusal>> {
  return readTemplateProfile(templateId)
}

/** One pair as a `'use client'` component receives it: `TemplateDuplicateView` with its two `Date`s
 *  turned into ISO strings, `CatalogRowView`'s own idiom. */
export type TemplateDuplicateRowView = Omit<TemplateDuplicateView, 'detectedAt' | 'dismissedAt'> & {
  readonly detectedAt: string
  readonly dismissedAt: string | null
}

/** Every pair one template is in, DISMISSED ONES INCLUDED (M55 R6): the drawer is the one surface
 *  that shows a dismissal, greyed, with a Restore beside it -- the chip on the row shows only the
 *  undismissed ones, which is why the two reads are different and not one. */
export async function listTemplateDuplicatesView(templateId: string): Promise<readonly TemplateDuplicateRowView[]> {
  // `.rows`, because the control read now answers a PAGE (final wave, Important 2). One template's
  // pairs are far below `TEMPLATE_DUPLICATES_LIMIT` -- a row cannot be in more pairs than the
  // catalog has rows -- so the drawer needs the list and not the total.
  const { rows } = await listTemplateDuplicates({ templateId, includeDismissed: true })
  return rows.map((row) => ({
    ...row,
    detectedAt: row.detectedAt.toISOString(),
    dismissedAt: row.dismissedAt === null ? null : row.dismissedAt.toISOString(),
  }))
}

/**
 * The capability taxonomy, under the web's own name for it (the `listWorkforceCatalogPage` idiom).
 *
 * A plain re-export of the control read: every field is already JSON (`CapabilityRecord` holds no
 * `Date`), so there is nothing to flatten -- what this adds is one name a page and a component can
 * import without either of them reaching into `@slave-of-ai/control` themselves.
 */
export async function listCapabilityTaxonomy(): Promise<readonly CapabilityRecord[]> {
  return listCapabilities()
}

/** What `GET /api/org/templates/:id/profile` serialises, under the name the client names it: every
 *  field of `TemplateProfileView` is already JSON-safe (`ProfileSpec.source.importedAt` is an ISO
 *  string, erratum E21), so this is that type rather than a second hand-written copy of it. */
export type TemplateProfileViewJson = TemplateProfileView

/** M42 §2: the last ten import runs, for the catalog imports panel. Dates as ISO strings, for the
 *  same reason `listTemplates` above hands out one. The three duplicate counts ride along since
 *  M55 R7 -- seven numbers here and seven in `list-imports`, out of one recorded report. */
export async function listCatalogImports(): Promise<
  readonly {
    id: string
    catalog: string
    directory: string
    by: string | null
    finishedAt: string
    created: number
    updated: number
    unchanged: number
    skipped: number
    duplicates: DuplicateCounts
  }[]
> {
  const rows = await listCatalogImportRows(10)
  return rows.map((row) => ({
    id: row.id,
    catalog: row.catalog,
    directory: row.directory,
    by: row.by,
    finishedAt: row.finishedAt.toISOString(),
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    skipped: row.skipped,
    // M55 R7 / plan erratum E9: the panel shows the same SEVEN numbers the CLI's `list-imports`
    // prints. Dropping these three here was what made the panel say six of the seven.
    duplicates: row.duplicates,
  }))
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
