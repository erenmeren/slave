import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_PER_CALL_CAP_USD,
  EVIDENCE_MIN_SAMPLE,
  INTAKE_PER_CALL_CAP_USD,
  PROJECT_PHASE_LABEL,
  SUBORDINATE_TOOLS,
  SUPERVISOR_PER_CALL_CAP_USD,
  projectPhaseOf,
  type LeadState,
  type WorkspaceFlow,
} from '@slave-of-ai/domain'
import { evidenceByModel, evidenceByProfile } from './evidence.js'
import { GENERAL_HELPER_DEFINITION, helperIdentities } from './helperNames.js'
import { goalWorkedMs } from './lead/spend.js'
import { workspaceSpend } from './spend.js'

/** The period Analytics looks at: the last 7 or 30 days (today included, days in UTC), or everything (null). */
export type AnalyticsDays = 7 | 30 | null

/** The period a query string asks for: `7`, `30` or `all`; anything else is 30 days. */
export function analyticsDaysOf(raw: string | null | undefined): AnalyticsDays {
  return raw === '7' ? 7 : raw === 'all' ? null : 30
}

export interface AnalyticsFilter {
  /** One project, or null for every project (archived ones included: their money was spent). */
  readonly projectId?: string | null
  readonly days?: AnalyticsDays
  /** The moment "now" is, for a test. */
  readonly now?: Date
}

/** Money by what it paid for. */
export interface MoneyParts {
  /** The lead's turns, its helpers inside them; in an older project, its workers' sessions. */
  readonly buildingUsd: number
  /** The checkers' runs (and an older project's reviews). */
  readonly checkingUsd: number
  /** Reading the request into requirements and steering the work: every model call that is not a session. */
  readonly steeringUsd: number
  readonly totalUsd: number
}

export interface DayMoney {
  /** `2026-10-05`, UTC. */
  readonly day: string
  readonly totalUsd: number
  /** The projects that spent that day, the largest first. */
  readonly byProject: readonly { readonly projectId: string; readonly usd: number }[]
}

export interface ProjectMoneyRow extends MoneyParts {
  readonly projectId: string
  readonly name: string
  readonly archived: boolean
  readonly flow: WorkspaceFlow
  /** Builds that were worked on in the period. */
  readonly builds: number
  readonly budgetUsd: number | null
  /** What the budget is measured against, whatever the period: the newest build's spend, or an older project's whole spend. */
  readonly budgetSpentUsd: number
  /** Sessions that ended in the period without reporting a cost: their money is in no sum. */
  readonly unmeasuredSessions: number
  /** Sessions still open: a session reports its cost when it ends. */
  readonly liveSessions: number
}

export type BuildGroup = 'delivered' | 'stopped' | 'waiting' | 'running'

/** One build with its WHOLE figures, whatever the period: a build is listed when it was worked on in it. */
export interface BuildRow {
  readonly projectId: string
  readonly projectName: string
  readonly version: number
  /** Its state in a person's words. */
  readonly state: string
  readonly group: BuildGroup
  readonly turns: number
  readonly helperSessions: number
  readonly steps: number
  readonly workedMs: number
  readonly spentUsd: number
  readonly unmeasuredSessions: number
  readonly liveSessions: number
  readonly startedAt: string
}

export interface HelperUsageRow {
  /** The catalogue person's id, else the definition's own word. */
  readonly key: string
  readonly name: string
  /** Null for a general helper and for a helper no roster person answers to any more. */
  readonly personId: string | null
  /** Times a lead started it. */
  readonly sessions: number
  readonly steps: number
  readonly failedSteps: number
  /** Projects it was called on. */
  readonly projects: number
  readonly lastAt: string | null
}

/** A rate, or no claim: `pct` is null while fewer than `EVIDENCE_MIN_SAMPLE` were judged. */
export interface EvidenceRate {
  readonly pct: number | null
  readonly judged: number
}

export interface EvidenceLine {
  readonly key: string
  readonly name: string
  /** The repository the rows are about; null on a by-model line. */
  readonly repository: string | null
  readonly attempted: number
  readonly firstPass: EvidenceRate
  readonly reviewRejected: EvidenceRate
  readonly integrated: EvidenceRate
  readonly medianDurationMs: number | null
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: number
  /** Fewer than `EVIDENCE_MIN_SAMPLE` sessions: too thin to say anything from. */
  readonly thin: boolean
}

/** Everything the Analytics page shows, in one read. */
export interface AnalyticsView {
  readonly days: AnalyticsDays
  /** The start of the period; null for everything. */
  readonly since: string | null
  readonly projectId: string | null
  /** Every project, for the filter. */
  readonly projects: readonly { readonly id: string; readonly name: string; readonly archived: boolean }[]
  readonly money: MoneyParts & {
    readonly unmeasuredSessions: number
    readonly liveSessions: number
    /** One entry per day of the period, empty days included; for "everything", the newest `ANALYTICS_CHART_DAYS` days from the first day with a figure. */
    readonly byDay: readonly DayMoney[]
    readonly byProject: readonly ProjectMoneyRow[]
    /** The newest `ANALYTICS_BUILD_ROWS` builds worked on in the period. */
    readonly byBuild: readonly BuildRow[]
  }
  readonly work: {
    readonly steps: number
    readonly byDay: readonly { readonly day: string; readonly steps: number }[]
    readonly leadTurns: number
    readonly helperSessions: number
    readonly checks: number
    /** The verdicts those checks gave, one per requirement per check. */
    readonly verdicts: { readonly works: number; readonly fails: number; readonly unverifiable: number }
    readonly builds: Readonly<Record<BuildGroup, number>>
    /** Null when no build was delivered. */
    readonly averageDeliveredWorkedMs: number | null
  }
  readonly helpers: readonly HelperUsageRow[]
  /** Every record, whatever the period: evidence is a running tally. */
  readonly evidence: {
    readonly profiles: readonly EvidenceLine[]
    readonly models: readonly EvidenceLine[]
    /** Records written at all, and those of them from projects a lead builds. */
    readonly records: number
    readonly leadFlowRecords: number
  }
  /** Sessions were cut at `ANALYTICS_RUN_CAP`: the oldest are not in the figures. */
  readonly truncated: boolean
}

/** The newest sessions the figures are made from. */
export const ANALYTICS_RUN_CAP = 5000
export const ANALYTICS_BUILD_ROWS = 50
export const ANALYTICS_CHART_DAYS = 90

const DAY_MS = 86_400_000
const dayOf = (date: Date): string => date.toISOString().slice(0, 10)
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6
const rateOf = (numerator: number, judged: number): EvidenceRate => ({ pct: judged < EVIDENCE_MIN_SAMPLE ? null : Math.round((numerator / judged) * 100), judged })

interface RunRow {
  readonly id: string
  readonly kind: string
  readonly leadTurn: string | null
  readonly sessionId: string | null
  readonly costUsd: number | null
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly workspaceId: string
  /** `<workspaceId>:<version>` of the build it worked on; null for a session of no build. */
  readonly build: string | null
}

type Part = 'buildingUsd' | 'checkingUsd' | 'steeringUsd'
const partOf = (run: RunRow): Part => (run.kind === 'verification' || run.kind === 'review' ? 'checkingUsd' : run.kind === 'planning' ? 'steeringUsd' : 'buildingUsd')

/**
 * Concluded sessions whose cost is in no sum. A lead turn that ended without a figure is covered
 * when a later turn of the same session reported one (`goalSpend`'s rule, C2): that figure holds
 * its spend.
 */
function unmeasuredOf(runs: readonly RunRow[]): ReadonlySet<string> {
  const bySession = new Map<string, RunRow[]>()
  for (const run of runs) if (run.leadTurn !== null && run.sessionId !== null) bySession.set(run.sessionId, [...(bySession.get(run.sessionId) ?? []), run])
  const unmeasured = new Set<string>()
  for (const run of runs) {
    if (run.endedAt === null || run.costUsd !== null) continue
    const session = run.leadTurn !== null && run.sessionId !== null ? (bySession.get(run.sessionId) ?? []) : []
    if (!session.some((later) => later.costUsd !== null && later.startedAt > run.startedAt)) unmeasured.add(run.id)
  }
  return unmeasured
}

interface DeliveryRow {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly status: string
  readonly leadState: LeadState | null
  readonly mergedAt: Date | null
  readonly createdAt: Date
}

const STATUSES = ['integrating', 'verifying', 'accepted', 'needs_human', 'abandoned'] as const
type DeliveryStatus = (typeof STATUSES)[number]
const asStatus = (status: string): DeliveryStatus => ((STATUSES as readonly string[]).includes(status) ? (status as DeliveryStatus) : 'integrating')

/** A build's state in a person's words, and which of the four piles it counts in. */
export function buildStateOf(input: { readonly flow: WorkspaceFlow; readonly haltedReason: string | null; readonly newest: boolean; readonly delivery: Pick<DeliveryRow, 'goalVersion' | 'status' | 'leadState' | 'mergedAt'> }): { readonly state: string; readonly group: BuildGroup } {
  const status = asStatus(input.delivery.status)
  if (input.flow === 'packages' || input.delivery.leadState === null) {
    if (input.delivery.mergedAt !== null) return { state: 'Delivered', group: 'delivered' }
    if (status === 'accepted') return { state: 'Ready to merge', group: 'waiting' }
    if (status === 'abandoned') return { state: 'Left unmerged', group: 'stopped' }
    if (status === 'needs_human') return { state: 'Needs a person', group: 'waiting' }
    if (!input.newest) return { state: 'Replaced by a newer build', group: 'stopped' }
    return { state: status === 'verifying' ? 'Checking' : 'Building', group: 'running' }
  }
  const phase = projectPhaseOf({ flow: 'lead', haltedReason: input.newest ? input.haltedReason : null, goalVersion: input.delivery.goalVersion, delivery: { goalVersion: input.delivery.goalVersion, leadState: input.delivery.leadState, status } })
  switch (phase) {
    case 'delivered':
      return { state: PROJECT_PHASE_LABEL[phase], group: 'delivered' }
    case 'closed':
      return { state: PROJECT_PHASE_LABEL[phase], group: 'stopped' }
    case 'needs_decision':
    case 'ready_to_merge':
    case 'paused':
    case 'failed':
      return { state: PROJECT_PHASE_LABEL[phase], group: 'waiting' }
    default:
      return input.newest ? { state: PROJECT_PHASE_LABEL[phase], group: 'running' } : { state: 'Replaced by a newer build', group: 'stopped' }
  }
}

interface ModelCallDay {
  readonly workspaceId: string
  readonly day: string
  readonly usd: number
}

/**
 * What the model calls that are no session cost, per project and day: the conductor's (reading the
 * request), the Supervisor's decisions and conversation, and the intake that made the project. A
 * call whose cost never came back is charged at its cap, `workspaceSpend`'s own rule, so the sum
 * over everything is that function's figure.
 */
async function modelCallDays(workspaceIds: readonly string[], since: Date | null): Promise<readonly ModelCallDay[]> {
  const from = (column: string): Prisma.Sql => (since === null ? Prisma.sql`TRUE` : Prisma.sql`${Prisma.raw(`"${column}"`)} >= ${since.toISOString()}::timestamp`)
  const ids = Prisma.sql`"workspaceId" = ANY(${[...workspaceIds]}::text[])`
  type Row = { readonly workspaceId: string; readonly day: string; readonly usd: number; readonly unmeasured: number }
  const [conductor, decisions, chat, intakes] = await Promise.all([
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT "workspaceId", to_char("createdAt", 'YYYY-MM-DD') AS day, COALESCE(SUM("modelCostUsd"), 0)::float8 AS usd, (COUNT(*) FILTER (WHERE "unmeasured"))::int AS unmeasured
      FROM "ConductorCall" WHERE ${ids} AND ${from('createdAt')} GROUP BY 1, 2`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT "workspaceId", to_char("createdAt", 'YYYY-MM-DD') AS day, COALESCE(SUM("modelCostUsd"), 0)::float8 AS usd, (COUNT(*) FILTER (WHERE "modelCalled" AND "modelCostUsd" IS NULL))::int AS unmeasured
      FROM "SupervisorDecision" WHERE ${ids} AND ${from('createdAt')} GROUP BY 1, 2`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT "workspaceId", to_char("createdAt", 'YYYY-MM-DD') AS day, COALESCE(SUM("modelCostUsd"), 0)::float8 AS usd, (COUNT(*) FILTER (WHERE "unmeasured"))::int AS unmeasured
      FROM "SupervisorMessage" WHERE ${ids} AND ${from('createdAt')} GROUP BY 1, 2`),
    prisma.intake.findMany({ where: { workspaceId: { in: [...workspaceIds] }, ...(since === null ? {} : { createdAt: { gte: since } }) }, select: { workspaceId: true, createdAt: true, modelCostUsd: true, unmeasuredCalls: true } }),
  ])
  const charged = (rows: readonly Row[], capUsd: number): ModelCallDay[] => rows.map((row) => ({ workspaceId: row.workspaceId, day: row.day, usd: row.usd + row.unmeasured * capUsd }))
  return [
    ...charged(conductor, CONDUCT_PER_CALL_CAP_USD),
    ...charged(decisions, SUPERVISOR_PER_CALL_CAP_USD),
    ...charged(chat, SUPERVISOR_PER_CALL_CAP_USD),
    ...intakes.flatMap((intake) => (intake.workspaceId === null ? [] : [{ workspaceId: intake.workspaceId, day: dayOf(intake.createdAt), usd: intake.modelCostUsd + intake.unmeasuredCalls * INTAKE_PER_CALL_CAP_USD }])),
  ].filter((row) => row.usd > 0)
}

interface StepRow {
  readonly runId: string
  readonly day: string
  readonly steps: number
  readonly helperSessions: number
}

/** Steps per session and day, counted in the database: the event table is never loaded. */
async function stepsByRunAndDay(runIds: readonly string[]): Promise<readonly StepRow[]> {
  if (runIds.length === 0) return []
  return prisma.$queryRaw<StepRow[]>(Prisma.sql`
    SELECT "runId", to_char(ts, 'YYYY-MM-DD') AS day, COUNT(*)::int AS steps,
           (COUNT(*) FILTER (WHERE payload->>'parentToolUseId' IS NULL AND payload->>'name' = ANY(${[...SUBORDINATE_TOOLS]}::text[])))::int AS "helperSessions"
    FROM "ExecutionEvent"
    WHERE "runId" = ANY(${[...runIds]}::text[]) AND type = 'run.tool_call'
    GROUP BY 1, 2`)
}

interface HelperTally {
  readonly workspaceId: string
  readonly definition: string
  readonly sessions: number
  readonly steps: number
  readonly failedSteps: number
  readonly lastAt: Date | null
}

/**
 * Which helpers the leads called, counted in the database from the events `buildPeople` reads: a
 * helper session is a lead's own call of a subordinate tool, and every call under it (a helper of
 * a helper included) is a step of the helper the lead started.
 */
async function helperTallies(leadRunIds: readonly string[], since: Date | null): Promise<readonly HelperTally[]> {
  if (leadRunIds.length === 0) return []
  const inPeriod = since === null ? Prisma.sql`TRUE` : Prisma.sql`ts >= ${since.toISOString()}::timestamp`
  return prisma.$queryRaw<HelperTally[]>(Prisma.sql`
    WITH RECURSIVE calls AS MATERIALIZED (
      SELECT "workspaceId", "runId", ts, payload->>'toolUseId' AS id, payload->>'parentToolUseId' AS parent, payload->>'name' AS name, payload->>'subagent' AS definition
      FROM "ExecutionEvent"
      WHERE "runId" = ANY(${[...leadRunIds]}::text[]) AND type = 'run.tool_call'
    ), failed AS MATERIALIZED (
      SELECT DISTINCT "runId", payload->>'toolUseId' AS id
      FROM "ExecutionEvent"
      WHERE "runId" = ANY(${[...leadRunIds]}::text[]) AND type = 'run.tool_result' AND payload->>'outcome' = 'error'
    ), tree AS (
      SELECT "workspaceId", "runId", ts, id, COALESCE(definition, ${GENERAL_HELPER_DEFINITION}) AS definition, TRUE AS started
      FROM calls WHERE parent IS NULL AND name = ANY(${[...SUBORDINATE_TOOLS]}::text[])
      UNION ALL
      SELECT c."workspaceId", c."runId", c.ts, c.id, t.definition, FALSE
      FROM calls c JOIN tree t ON c.parent = t.id AND c."runId" = t."runId"
    )
    SELECT t."workspaceId", t.definition,
           (COUNT(*) FILTER (WHERE t.started))::int AS sessions,
           (COUNT(*) FILTER (WHERE NOT t.started))::int AS steps,
           (COUNT(*) FILTER (WHERE NOT t.started AND f.id IS NOT NULL))::int AS "failedSteps",
           MAX(t.ts) AS "lastAt"
    FROM tree t LEFT JOIN failed f ON f.id = t.id AND f."runId" = t."runId"
    WHERE ${inPeriod}
    GROUP BY 1, 2`)
}

/**
 * The Analytics page's one read: what was spent, where and on what; how much work was done; which
 * helpers were called; and the evidence tally. Sessions are few (tens per build) and are read as
 * rows, the newest `ANALYTICS_RUN_CAP`; steps are thousands per build and are only ever counted in
 * the database. A read: nothing here writes.
 *
 * WHEN a figure counts. A session's money lands on the day it ENDED (the runtime reports a cost
 * when a session ends), a model call's on the day it was made, a step's on the day it was made. A
 * session is "in the period" when it ended in it or is still open.
 */
export async function analyticsView(filter: AnalyticsFilter = {}): Promise<AnalyticsView> {
  const now = filter.now ?? new Date()
  const days = filter.days === undefined ? 30 : filter.days
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const since = days === null ? null : new Date(today.getTime() - (days - 1) * DAY_MS)

  const all = await prisma.workspace.findMany({
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    select: { id: true, name: true, flow: true, archivedAt: true, haltedReason: true, goalVersion: true, budgetUsd: true, leadRoster: true },
  })
  const projects = all.map((workspace) => ({ id: workspace.id, name: workspace.name, archived: workspace.archivedAt !== null }))
  const projectId = filter.projectId != null && all.some((workspace) => workspace.id === filter.projectId) ? filter.projectId : null
  const chosen = projectId === null ? all : all.filter((workspace) => workspace.id === projectId)
  const ids = chosen.map((workspace) => workspace.id)
  const workspaceOf = new Map(chosen.map((workspace) => [workspace.id, workspace]))

  const [loaded, deliveries, calls, conductorByBuild, verdictRows, profiles, models, records, leadFlowRecords] = await Promise.all([
    prisma.slaveRun.findMany({
      where: { slave: { team: { workspaceId: { in: ids } } } },
      orderBy: { startedAt: 'desc' },
      take: ANALYTICS_RUN_CAP + 1,
      select: {
        id: true,
        kind: true,
        leadTurn: true,
        sessionId: true,
        costUsd: true,
        startedAt: true,
        endedAt: true,
        slave: { select: { team: { select: { workspaceId: true } } } },
        task: { select: { workPackage: { select: { goalVersion: true } } } },
        goalDelivery: { select: { goalVersion: true } },
      },
    }),
    prisma.goalDelivery.findMany({ where: { workspaceId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { workspaceId: true, goalVersion: true, status: true, leadState: true, mergedAt: true, createdAt: true } }),
    modelCallDays(ids, since),
    prisma.conductorCall.groupBy({ by: ['workspaceId', 'goalVersion'], where: { workspaceId: { in: ids } }, _sum: { modelCostUsd: true } }),
    prisma.verificationResult.groupBy({ by: ['status'], where: { workspaceId: { in: ids }, ...(since === null ? {} : { createdAt: { gte: since } }) }, _count: { _all: true } }),
    evidenceByProfile({ workspaceId: projectId }),
    evidenceByModel({ workspaceId: projectId }),
    prisma.evidenceRecord.count({ where: projectId === null ? {} : { workspaceId: projectId } }),
    prisma.evidenceRecord.count({ where: { workspace: { flow: 'lead' }, ...(projectId === null ? {} : { workspaceId: projectId }) } }),
  ])
  const truncated = loaded.length > ANALYTICS_RUN_CAP
  const runs: RunRow[] = loaded.slice(0, ANALYTICS_RUN_CAP).map((run) => {
    const workspaceId = run.slave.team.workspaceId
    const version = run.goalDelivery?.goalVersion ?? run.task?.workPackage?.goalVersion ?? null
    return { id: run.id, kind: run.kind, leadTurn: run.leadTurn, sessionId: run.sessionId, costUsd: run.costUsd, startedAt: run.startedAt, endedAt: run.endedAt, workspaceId, build: version === null ? null : `${workspaceId}:${String(version)}` }
  })
  const unmeasured = unmeasuredOf(runs)
  const inPeriod = (run: RunRow): boolean => since === null || run.endedAt === null || run.endedAt >= since
  const active = runs.filter(inPeriod)

  // The builds worked on in the period: made in it, or with a session in it.
  const buildKey = (delivery: DeliveryRow): string => `${delivery.workspaceId}:${String(delivery.goalVersion)}`
  const touched = new Set(active.flatMap((run) => (run.build === null ? [] : [run.build])))
  const activeBuilds = deliveries.filter((delivery) => since === null || delivery.createdAt >= since || touched.has(buildKey(delivery)))
  const listed = activeBuilds.slice(0, ANALYTICS_BUILD_ROWS)
  const listedKeys = new Set(listed.map(buildKey))
  const runsOfBuild = new Map<string, RunRow[]>()
  for (const run of runs) if (run.build !== null) runsOfBuild.set(run.build, [...(runsOfBuild.get(run.build) ?? []), run])

  const countedRuns = [...new Map([...active, ...runs.filter((run) => run.build !== null && listedKeys.has(run.build))].map((run) => [run.id, run])).values()]
  const leadRunIds = countedRuns.filter((run) => run.leadTurn !== null).map((run) => run.id)
  const [stepRows, tallies, helper] = await Promise.all([
    stepsByRunAndDay(countedRuns.map((run) => run.id)),
    helperTallies(leadRunIds, since),
    helperIdentities(new Map(chosen.map((workspace) => [workspace.id, workspace.leadRoster]))),
  ])
  const sinceDay = since === null ? null : dayOf(since)
  const stepInPeriod = (row: StepRow): boolean => sinceDay === null || row.day >= sinceDay
  const leadRuns = new Set(leadRunIds)

  // Money: a session's on the day it ended, a model call's on the day it was made.
  const moneyDays = new Map<string, Map<string, number>>()
  const perProject = new Map<string, { buildingUsd: number; checkingUsd: number; steeringUsd: number; unmeasured: number; live: number }>()
  const projectTally = (workspaceId: string): { buildingUsd: number; checkingUsd: number; steeringUsd: number; unmeasured: number; live: number } => {
    const found = perProject.get(workspaceId)
    if (found !== undefined) return found
    const made = { buildingUsd: 0, checkingUsd: 0, steeringUsd: 0, unmeasured: 0, live: 0 }
    perProject.set(workspaceId, made)
    return made
  }
  const spendOn = (day: string, workspaceId: string, usd: number): void => {
    if (usd <= 0) return
    const byProject = moneyDays.get(day) ?? new Map<string, number>()
    byProject.set(workspaceId, (byProject.get(workspaceId) ?? 0) + usd)
    moneyDays.set(day, byProject)
  }
  for (const run of active) {
    const tally = projectTally(run.workspaceId)
    if (run.endedAt === null) tally.live += 1
    if (unmeasured.has(run.id)) tally.unmeasured += 1
    if (run.costUsd === null) continue
    tally[partOf(run)] += run.costUsd
    spendOn(dayOf(run.endedAt ?? run.startedAt), run.workspaceId, run.costUsd)
  }
  for (const call of calls) {
    projectTally(call.workspaceId).steeringUsd += call.usd
    spendOn(call.day, call.workspaceId, call.usd)
  }

  // The days of the charts: every day of the period; for everything, from the first day with a figure.
  const stepDays = new Map<string, number>()
  for (const row of stepRows) if (stepInPeriod(row)) stepDays.set(row.day, (stepDays.get(row.day) ?? 0) + row.steps)
  const firstDay = [...moneyDays.keys(), ...stepDays.keys()].sort()[0]
  const chartStart = since ?? (firstDay === undefined ? null : new Date(Math.max(Date.parse(`${firstDay}T00:00:00.000Z`), today.getTime() - (ANALYTICS_CHART_DAYS - 1) * DAY_MS)))
  const chartDays: string[] = []
  if (chartStart !== null) for (let at = chartStart.getTime(); at <= today.getTime(); at += DAY_MS) chartDays.push(dayOf(new Date(at)))

  // Each build with its whole figures.
  const conductorOf = new Map(conductorByBuild.map((row) => [`${row.workspaceId}:${String(row.goalVersion)}`, row._sum.modelCostUsd ?? 0]))
  const stepsOfRun = new Map<string, { steps: number; helperSessions: number }>()
  for (const row of stepRows) {
    const tally = stepsOfRun.get(row.runId) ?? { steps: 0, helperSessions: 0 }
    tally.steps += row.steps
    if (leadRuns.has(row.runId)) tally.helperSessions += row.helperSessions
    stepsOfRun.set(row.runId, tally)
  }
  const newestOf = new Map<string, number>()
  for (const delivery of deliveries) newestOf.set(delivery.workspaceId, Math.max(newestOf.get(delivery.workspaceId) ?? 0, delivery.goalVersion))
  const stateOf = (delivery: DeliveryRow): { readonly state: string; readonly group: BuildGroup } => {
    const workspace = workspaceOf.get(delivery.workspaceId)
    return buildStateOf({ flow: workspace?.flow ?? 'lead', haltedReason: workspace?.haltedReason ?? null, newest: newestOf.get(delivery.workspaceId) === delivery.goalVersion, delivery })
  }
  const spendOfBuild = (key: string): { readonly usd: number; readonly unmeasured: number; readonly live: number } => {
    const own = runsOfBuild.get(key) ?? []
    return {
      usd: round(own.reduce((total, run) => total + (run.costUsd ?? 0), 0) + (conductorOf.get(key) ?? 0)),
      unmeasured: own.filter((run) => unmeasured.has(run.id)).length,
      live: own.filter((run) => run.endedAt === null).length,
    }
  }
  const byBuild = await Promise.all(
    listed.map(async (delivery): Promise<BuildRow> => {
      const key = buildKey(delivery)
      const own = runsOfBuild.get(key) ?? []
      const spend = spendOfBuild(key)
      return {
        projectId: delivery.workspaceId,
        projectName: workspaceOf.get(delivery.workspaceId)?.name ?? '',
        version: delivery.goalVersion,
        ...stateOf(delivery),
        turns: own.filter((run) => run.leadTurn !== null).length,
        helperSessions: own.reduce((total, run) => total + (stepsOfRun.get(run.id)?.helperSessions ?? 0), 0),
        steps: own.reduce((total, run) => total + (stepsOfRun.get(run.id)?.steps ?? 0), 0),
        workedMs: await goalWorkedMs(delivery.workspaceId, delivery.goalVersion, now),
        spentUsd: spend.usd,
        unmeasuredSessions: spend.unmeasured,
        liveSessions: spend.live,
        startedAt: delivery.createdAt.toISOString(),
      }
    }),
  )

  // Each project: every one that is not archived, and an archived one that has a figure.
  const buildsOf = new Map<string, number>()
  for (const delivery of activeBuilds) buildsOf.set(delivery.workspaceId, (buildsOf.get(delivery.workspaceId) ?? 0) + 1)
  const byProject = (
    await Promise.all(
      chosen.map(async (workspace): Promise<ProjectMoneyRow | null> => {
        const tally = projectTally(workspace.id)
        const totalUsd = round(tally.buildingUsd + tally.checkingUsd + tally.steeringUsd)
        const builds = buildsOf.get(workspace.id) ?? 0
        if (workspace.archivedAt !== null && projectId === null && totalUsd === 0 && builds === 0 && tally.live === 0 && tally.unmeasured === 0) return null
        const newest = newestOf.get(workspace.id)
        const budgetSpentUsd = workspace.budgetUsd === null ? 0 : workspace.flow === 'lead' ? (newest === undefined ? 0 : spendOfBuild(`${workspace.id}:${String(newest)}`).usd) : (await workspaceSpend(workspace.id)).spentUsd
        return {
          projectId: workspace.id,
          name: workspace.name,
          archived: workspace.archivedAt !== null,
          flow: workspace.flow,
          builds,
          buildingUsd: round(tally.buildingUsd),
          checkingUsd: round(tally.checkingUsd),
          steeringUsd: round(tally.steeringUsd),
          totalUsd,
          budgetUsd: workspace.budgetUsd,
          budgetSpentUsd,
          unmeasuredSessions: tally.unmeasured,
          liveSessions: tally.live,
        }
      }),
    )
  )
    .filter((row): row is ProjectMoneyRow => row !== null)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.totalUsd - a.totalUsd || a.name.localeCompare(b.name))
  const sumOf = (key: Part | 'totalUsd'): number => round(byProject.reduce((total, row) => total + row[key], 0))

  // The helpers, the same person on two projects counted as one.
  const helpers = new Map<string, { name: string; personId: string | null; sessions: number; steps: number; failedSteps: number; projects: Set<string>; lastAt: Date | null }>()
  for (const tally of tallies) {
    if (tally.sessions === 0 && tally.steps === 0) continue
    const who = helper(tally.workspaceId, tally.definition)
    const key = who.personId ?? `definition:${tally.definition}`
    const row = helpers.get(key) ?? { name: who.name, personId: who.personId, sessions: 0, steps: 0, failedSteps: 0, projects: new Set<string>(), lastAt: null }
    row.sessions += tally.sessions
    row.steps += tally.steps
    row.failedSteps += tally.failedSteps
    row.projects.add(tally.workspaceId)
    if (tally.lastAt !== null && (row.lastAt === null || tally.lastAt > row.lastAt)) row.lastAt = tally.lastAt
    helpers.set(key, row)
  }

  const groups: Record<BuildGroup, number> = { delivered: 0, stopped: 0, waiting: 0, running: 0 }
  for (const delivery of activeBuilds) groups[stateOf(delivery).group] += 1
  const delivered = byBuild.filter((row) => row.group === 'delivered')
  const verdicts = (status: string): number => verdictRows.find((row) => row.status === status)?._count._all ?? 0
  const evidenceLine = (group: (typeof profiles)[number] | (typeof models)[number], key: string, name: string, repository: string | null): EvidenceLine => ({
    key,
    name,
    repository,
    attempted: group.attempted,
    firstPass: rateOf(group.firstPassPassed, group.firstPassJudged),
    reviewRejected: rateOf(group.reviewRejected, group.reviewJudged),
    integrated: rateOf(group.integrated, group.integrationJudged),
    medianDurationMs: group.medianDurationMs,
    reportedUsd: group.reportedUsd,
    estimatedUsd: group.estimatedUsd,
    unmeasuredRuns: group.unmeasuredRuns,
    thin: group.attempted < EVIDENCE_MIN_SAMPLE,
  })

  return {
    days,
    since: since?.toISOString() ?? null,
    projectId,
    projects,
    money: {
      buildingUsd: sumOf('buildingUsd'),
      checkingUsd: sumOf('checkingUsd'),
      steeringUsd: sumOf('steeringUsd'),
      totalUsd: sumOf('totalUsd'),
      unmeasuredSessions: byProject.reduce((total, row) => total + row.unmeasuredSessions, 0),
      liveSessions: byProject.reduce((total, row) => total + row.liveSessions, 0),
      byDay: chartDays.map((day) => {
        const parts = [...(moneyDays.get(day) ?? new Map<string, number>())].map(([id, usd]) => ({ projectId: id, usd: round(usd) })).sort((a, b) => b.usd - a.usd)
        return { day, totalUsd: round(parts.reduce((total, part) => total + part.usd, 0)), byProject: parts }
      }),
      byProject,
      byBuild,
    },
    work: {
      steps: [...stepDays.values()].reduce((total, steps) => total + steps, 0),
      byDay: chartDays.map((day) => ({ day, steps: stepDays.get(day) ?? 0 })),
      leadTurns: active.filter((run) => run.leadTurn !== null).length,
      helperSessions: stepRows.reduce((total, row) => total + (stepInPeriod(row) && leadRuns.has(row.runId) ? row.helperSessions : 0), 0),
      checks: active.filter((run) => run.kind === 'verification').length,
      verdicts: { works: verdicts('pass'), fails: verdicts('fail'), unverifiable: verdicts('unverifiable') },
      builds: groups,
      averageDeliveredWorkedMs: delivered.length === 0 ? null : Math.round(delivered.reduce((total, row) => total + row.workedMs, 0) / delivered.length),
    },
    helpers: [...helpers]
      .map(([key, row]): HelperUsageRow => ({ key, name: row.name, personId: row.personId, sessions: row.sessions, steps: row.steps, failedSteps: row.failedSteps, projects: row.projects.size, lastAt: row.lastAt?.toISOString() ?? null }))
      .sort((a, b) => b.sessions - a.sessions || b.steps - a.steps || a.name.localeCompare(b.name)),
    evidence: {
      profiles: profiles.map((group) => evidenceLine(group, `${group.profileKey}:${group.repositoryKey}`, group.name, group.repositoryKey)),
      models: models.map((group) => evidenceLine(group, group.model ?? '', group.model ?? 'No model recorded', null)),
      records,
      leadFlowRecords,
    },
    truncated,
  }
}
