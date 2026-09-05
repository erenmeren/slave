import { prisma } from '@slave-of-ai/db/client'
import { sumSpend, type RunStatus } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildAnalytics, perSlaveRunAggregates } from '../../src/server/analytics.js'

/**
 * Equivalence test for Task 12 (M17): `perSlaveRunAggregates` (one grouped SQL query) must produce
 * exactly what the OLD `allRuns` findMany + JS reduce pass produced, for every rule branch that pass
 * had to distinguish. `oldPerSlave` below is a VERBATIM copy of the old computation (analytics.ts
 * :99-113 for the `allRuns` select, :194-218 for the `slaves.map` body) frozen here as the oracle —
 * it must never be "improved" to match the new code; if it drifts from what analytics.ts used to do,
 * the test stops proving anything.
 */

interface Fixture {
  readonly workspaceId: string
  readonly slaveAId: string
  readonly slaveBId: string
  readonly otherWorkspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout', repoPath: '/tmp/analytics-agg-fixture', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slaveA = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const slaveB = await prisma.slave.create({ data: { teamId: team.id, name: 'Bea', role: 'qa' } })

  const other = await prisma.workspace.create({
    data: { name: 'Other', repoPath: '/tmp/analytics-agg-other', verifyCommands: ['true'], setupCommands: [] },
  })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
  const otherSlave = await prisma.slave.create({ data: { teamId: otherTeam.id, name: 'Cam', role: 'qa' } })
  await prisma.slaveRun.create({
    data: {
      slaveId: otherSlave.id,
      status: 'succeeded',
      provider: 'claude_code',
      costUsd: 5,
      tokensIn: 40,
      tokensOut: 60,
      toolCalls: 5,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:02:00Z'),
      terminalAt: new Date('2026-01-01T00:02:00Z'),
    },
  })

  return { workspaceId: workspace.id, slaveAId: slaveA.id, slaveBId: slaveB.id, otherWorkspaceId: other.id }
}

const t0 = new Date('2026-02-01T00:00:00Z')
const plusMs = (ms: number): Date => new Date(t0.getTime() + ms)

/** The seven rule-branch rows the brief lists, split across the two slaves. */
async function seedRuleBranchRuns(fixture: Fixture): Promise<void> {
  await prisma.slaveRun.createMany({
    data: [
      // 1. succeeded terminal run with cost, tokens, sane duration.
      {
        slaveId: fixture.slaveAId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 2.5,
        tokensIn: 100,
        tokensOut: 200,
        toolCalls: 3,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // 2. failed terminal run with no cost, provider set -> unmeasured.
      {
        slaveId: fixture.slaveAId,
        status: 'failed',
        provider: 'claude_code',
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        toolCalls: 1,
        startedAt: t0,
        endedAt: plusMs(30_000),
        terminalAt: plusMs(30_000),
      },
      // 3. in-flight `working` run, null cost -> NOT unmeasured, no duration, tokens if reported.
      {
        slaveId: fixture.slaveBId,
        status: 'working',
        provider: 'claude_code',
        costUsd: null,
        tokensIn: 50,
        tokensOut: null,
        toolCalls: 2,
        startedAt: t0,
        endedAt: null,
        terminalAt: null,
      },
      // 4. pre-M12-shaped row: real costUsd, provider: null -> money in known, never unmeasured.
      {
        slaveId: fixture.slaveBId,
        status: 'succeeded',
        provider: null,
        costUsd: 3,
        tokensIn: null,
        tokensOut: null,
        toolCalls: 0,
        startedAt: t0,
        endedAt: plusMs(10_000),
        terminalAt: plusMs(10_000),
      },
      // 5. terminal run with costUsd: 0 -> measured zero.
      {
        slaveId: fixture.slaveAId,
        status: 'failed',
        provider: 'claude_code',
        costUsd: 0,
        tokensIn: null,
        tokensOut: null,
        toolCalls: 1,
        startedAt: t0,
        endedAt: plusMs(5_000),
        terminalAt: plusMs(5_000),
      },
      // 6. run with only tokensOut set -> counts as reported.
      {
        slaveId: fixture.slaveBId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 1.25,
        tokensIn: null,
        tokensOut: 75,
        toolCalls: 4,
        startedAt: t0,
        endedAt: plusMs(20_000),
        terminalAt: plusMs(20_000),
      },
      // 7. terminal run with endedAt < startedAt -> excluded from durations by both paths.
      {
        slaveId: fixture.slaveAId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 0.5,
        tokensIn: 10,
        tokensOut: 10,
        toolCalls: 2,
        startedAt: plusMs(100_000),
        endedAt: plusMs(50_000),
        terminalAt: plusMs(50_000),
      },
    ],
  })
}

interface OldRun {
  readonly slaveId: string
  readonly status: RunStatus
  readonly provider: string | null
  readonly costUsd: number | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly toolCalls: number
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly terminalAt: Date | null
}

interface KpiIngredients {
  readonly durationSum: number
  readonly durationCount: number
  readonly spend: { readonly known: number; readonly unknownRuns: number }
  readonly toolCalls: number
}

interface OldResult {
  readonly perSlave: ReadonlyArray<{
    readonly slaveId: string
    readonly name: string
    readonly role: string
    readonly runs: number
    readonly successPct: number | null
    readonly avgDurationMs: number | null
    readonly tokens: number | null
    readonly costUsd: number
    readonly unmeasuredRuns: number
  }>
  readonly kpiIngredients: KpiIngredients
}

/** Verbatim oracle: analytics.ts :99-113 (the `allRuns` select) + :194-218 (the `slaves.map` body),
 *  frozen as it stood before Task 12's rewrite. */
async function oldPerSlave(workspaceId: string | null): Promise<OldResult> {
  const slaveWhere = workspaceId === null ? {} : { team: { workspaceId } }
  const runWhere = workspaceId === null ? {} : { slave: { team: { workspaceId } } }

  const slaves = await prisma.slave.findMany({
    where: slaveWhere,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, role: true },
  })
  const allRuns: OldRun[] = await prisma.slaveRun.findMany({
    where: runWhere,
    select: {
      slaveId: true,
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
  })

  // ---- KPI ingredients (old path) ----
  const terminalRuns = allRuns.filter((run) => run.terminalAt !== null && run.endedAt !== null)
  const durations = terminalRuns
    .map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime())
    .filter((ms) => ms >= 0)
  const spend = sumSpend(allRuns.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))
  const toolCalls = allRuns.reduce((n, run) => n + run.toolCalls, 0)

  // ---- per-slave performance (old path) ----
  const runsBySlave = new Map<string, OldRun[]>()
  for (const run of allRuns) {
    const list = runsBySlave.get(run.slaveId)
    if (list === undefined) runsBySlave.set(run.slaveId, [run])
    else list.push(run)
  }

  const perSlave = slaves.map((slave) => {
    const runs = runsBySlave.get(slave.id) ?? []
    const terminal = runs.filter((run) => run.terminalAt !== null)
    const succeeded = terminal.filter((run) => run.status === 'succeeded').length
    const slaveDurations = terminal
      .filter((run) => run.endedAt !== null)
      .map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime())
      .filter((ms) => ms >= 0)
    const reported = runs.filter((run) => run.tokensIn !== null || run.tokensOut !== null)
    const slaveSpend = sumSpend(runs.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))

    return {
      slaveId: slave.id,
      name: slave.name,
      role: slave.role,
      runs: terminal.length,
      successPct: terminal.length === 0 ? null : Math.round((succeeded / terminal.length) * 100),
      avgDurationMs: slaveDurations.length === 0 ? null : slaveDurations.reduce((a, b) => a + b, 0) / slaveDurations.length,
      tokens: reported.length === 0 ? null : reported.reduce((n, run) => n + (run.tokensIn ?? 0) + (run.tokensOut ?? 0), 0),
      costUsd: slaveSpend.known,
      unmeasuredRuns: slaveSpend.unknownRuns,
    }
  })

  return {
    perSlave,
    kpiIngredients: {
      durationSum: durations.reduce((a, b) => a + b, 0),
      durationCount: durations.length,
      spend,
      toolCalls,
    },
  }
}

/** Sums `perSlaveRunAggregates`' rows into the same KPI ingredients the old `allRuns` reduce
 *  produced, so the two paths can be compared at the KPI level too, not just per-slave. */
async function newKpiIngredients(workspaceId: string | null): Promise<KpiIngredients> {
  const aggRows = await perSlaveRunAggregates(workspaceId)
  let durationSum = 0
  let durationCount = 0
  let known = 0
  let unknownRuns = 0
  let toolCalls = 0
  for (const row of aggRows) {
    durationSum += row.durationMsSum ?? 0
    durationCount += Number(row.durationCount)
    known += row.knownUsd ?? 0
    unknownRuns += Number(row.unmeasured)
    toolCalls += Number(row.toolCalls)
  }
  return { durationSum, durationCount, spend: { known, unknownRuns }, toolCalls }
}

describe('perSlaveRunAggregates equivalence with the old allRuns + JS reduce path', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    await seedRuleBranchRuns(fixture)
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('matches the old per-slave rows and KPI ingredients, scoped to the seeded workspace', async (): Promise<void> => {
    const old = await oldPerSlave(fixture.workspaceId)
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.perSlave).toEqual(old.perSlave)

    const newKpis = await newKpiIngredients(fixture.workspaceId)
    expect(newKpis).toEqual(old.kpiIngredients)
  })

  it('matches the old per-slave rows and KPI ingredients across every workspace (workspaceId: null)', async (): Promise<void> => {
    const old = await oldPerSlave(null)
    const snapshot = await buildAnalytics(null)
    expect(snapshot.perSlave).toEqual(old.perSlave)

    const newKpis = await newKpiIngredients(null)
    expect(newKpis).toEqual(old.kpiIngredients)
  })

  it('scopes perSlaveRunAggregates rows to the given workspace, and to every slave when null', async (): Promise<void> => {
    const scoped = await perSlaveRunAggregates(fixture.workspaceId)
    expect(scoped.map((r) => r.slaveId).sort()).toEqual([fixture.slaveAId, fixture.slaveBId].sort())

    const global = await perSlaveRunAggregates(null)
    expect(global.length).toBe(3) // Alex, Bea, Cam (the other workspace's slave)
  })

  it('never counts an in-flight run as unmeasured even with a null cost (rule branch 3)', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const bea = snapshot.perSlave.find((r) => r.name === 'Bea')
    // Bea's runs: working (null cost, in-flight -> not unmeasured), pre-M12 costUsd:3/provider:null
    // (money known, never unmeasured), and a costUsd:1.25 run. None of Bea's runs is unmeasured.
    expect(bea?.unmeasuredRuns).toBe(0)
  })

  it('counts pre-M12-shaped money (real costUsd, null provider) as known, never unmeasured (rule branch 4)', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const bea = snapshot.perSlave.find((r) => r.name === 'Bea')
    expect(bea?.costUsd).toBeCloseTo(3 + 1.25, 6)
  })

  it('excludes an endedAt < startedAt row from durations while still counting it as terminal (rule branch 7)', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const alex = snapshot.perSlave.find((r) => r.name === 'Alex')
    // Alex has 4 terminal runs (rows 1, 2, 5, 7) but only rows 1, 2, 5 have a valid duration.
    expect(alex?.runs).toBe(4)
    expect(alex?.avgDurationMs).toBeCloseTo((60_000 + 30_000 + 5_000) / 3, 6)
  })
})
