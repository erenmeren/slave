import { prisma } from '@slave-of-ai/db/client'
import { workspaceSpend } from '@slave-of-ai/control'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listProjects } from '../../src/server/org.js'

/**
 * Equivalence test for Task 13 (M17): `listProjects`' spend path must produce the SAME `spend` /
 * `unmeasuredRuns` numbers whether it is computed from the whole-table `findMany` + `sumSpend`
 * pass (the pre-rewrite implementation) or from `slaveRun.groupBy` + `sumSpendFromGroups` (the
 * rewrite). This file is run TWICE against the same fixture -- once before the rewrite (the
 * equivalence claim) and once after -- and must pass unchanged both times.
 *
 * The fixture seeds one row per rule branch `sumSpend`'s doc comment distinguishes (same branches
 * as Task 12 step 1's oracle test): an unmeasured run, an in-flight run, a pre-M12-shaped row
 * (real `costUsd`, null `provider`), a measured zero, and an ordinary measured cost. The expected
 * numbers below are computed BY HAND from those five rows, not derived from either implementation.
 */

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveId: string
}

async function seed(name = 'Spend Groups Fixture'): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      repoPath: '/tmp/org-spend-groups-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, teamId: team.id, slaveId: slave.id }
}

const t0 = new Date('2026-02-01T00:00:00Z')
const plusMs = (ms: number): Date => new Date(t0.getTime() + ms)

/** The five rule-branch rows, hand-mapped to their contribution below. */
async function seedRuleBranchRuns(fixture: Fixture): Promise<void> {
  await prisma.slaveRun.createMany({
    data: [
      // 1. Unmeasured: spawned (provider set), finished (terminal status), no cost reported.
      //    -> known += 0, unmeasuredRuns += 1
      {
        slaveId: fixture.slaveId,
        status: 'failed',
        provider: 'claude_code',
        costUsd: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // 2. In flight: non-terminal status, no cost yet. Unfinished is not unmeasured.
      //    -> known += 0, unmeasuredRuns += 0
      {
        slaveId: fixture.slaveId,
        status: 'working',
        provider: 'claude_code',
        costUsd: null,
        startedAt: t0,
      },
      // 3. Pre-M12-shaped row: real cost, null provider (the column did not exist yet).
      //    Its money stays in `known`; the null provider means it can never qualify as unmeasured.
      //    -> known += 2.00, unmeasuredRuns += 0
      {
        slaveId: fixture.slaveId,
        status: 'succeeded',
        provider: null,
        costUsd: 2.0,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // 4. Measured zero: a run that genuinely cost nothing is a MEASURED zero, not a hole.
      //    -> known += 0, unmeasuredRuns += 0
      {
        slaveId: fixture.slaveId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 0,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // 5. Ordinary measured cost.
      //    -> known += 1.25, unmeasuredRuns += 0
      {
        slaveId: fixture.slaveId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 1.25,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
    ],
  })
}

// By hand: known = 0 (row 1) + 0 (row 2) + 2.00 (row 3) + 0 (row 4) + 1.25 (row 5) = 3.25.
// unmeasuredRuns: only row 1 qualifies (provider written, terminal, no cost) = 1.
const EXPECTED_SPEND = 3.25
const EXPECTED_UNMEASURED_RUNS = 1

describe('listProjects spend groups equivalence', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SupervisorDecision", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    await seedRuleBranchRuns(fixture)
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('computes the exact hand-computed spend and unmeasuredRuns over every rule branch', async (): Promise<void> => {
    const projects = await listProjects()
    const project = projects.find((p) => p.id === fixture.workspaceId)

    expect(project?.spend).toBeCloseTo(EXPECTED_SPEND)
    expect(project?.unmeasuredRuns).toBe(EXPECTED_UNMEASURED_RUNS)
  })
})

/**
 * M39 §4: a project's spend on the Projects page is the WHOLE workspace's spend -- the runs plus
 * what the Supervisor's own model calls cost -- and it is the SAME number `workspaceSpend` gives
 * the budget guardrail, the overview's bar and the shell. Two spellings of one formula would drift,
 * and the drift would be a project that looks cheaper on the list than it is everywhere else.
 *
 * The decision rows below cover the three branches `workspaceSpend`'s doc comment distinguishes:
 * a measured call, an UNMEASURED one (`modelCalled` with a null cost -- charged at the per-call
 * cap), and a rules-only decision that called nobody and costs nothing.
 */
async function seedDecisions(workspaceId: string, rows: readonly { modelCalled: boolean; modelCostUsd: number | null }[]): Promise<void> {
  const action = { kind: 'no_action' }
  await prisma.supervisorDecision.createMany({
    data: rows.map((row) => ({
      workspaceId,
      situationKind: 'ready_unstaffed' as const,
      subjectId: 'backend',
      situation: { kind: 'ready_unstaffed', subjectId: 'backend', summary: 'nobody holds backend', facts: {} },
      candidates: [{ action, tier: 'noop', why: 'waiting is reasonable.' }],
      chosenIndex: 0,
      action,
      rationale: 'nothing to do.',
      tier: 'noop' as const,
      status: 'applied' as const,
      decidedBy: row.modelCalled ? ('model' as const) : ('rules' as const),
      modelCalled: row.modelCalled,
      modelCostUsd: row.modelCostUsd,
    })),
  })
}

describe('listProjects counts the Supervisor spend', () => {
  let fixture: Fixture
  let other: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SupervisorDecision", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    await seedRuleBranchRuns(fixture)
    // A SECOND project, decided on and spent on separately: the merge is per workspace, and one
    // query over every project's decisions must not pour one project's money into another's row.
    other = await seed('Spend Groups Second Project')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it("adds the Supervisor's measured calls and charges its unmeasured ones at the per-call cap", async (): Promise<void> => {
    await seedDecisions(fixture.workspaceId, [
      { modelCalled: true, modelCostUsd: 0.3 },
      { modelCalled: true, modelCostUsd: null },
      { modelCalled: false, modelCostUsd: null },
    ])

    const project = (await listProjects()).find((p) => p.id === fixture.workspaceId)

    expect(project?.spend).toBeCloseTo(EXPECTED_SPEND + 0.3 + SUPERVISOR_PER_CALL_CAP_USD)
    // A model call is not a run: the unmeasured-RUN count beside the figure is untouched by any of
    // this (it answers a different question, and `sumSpendFromGroups` owns it).
    expect(project?.unmeasuredRuns).toBe(EXPECTED_UNMEASURED_RUNS)
  })

  it('shows exactly what workspaceSpend shows, for every project on the list', async (): Promise<void> => {
    await seedDecisions(fixture.workspaceId, [
      { modelCalled: true, modelCostUsd: 0.3 },
      { modelCalled: true, modelCostUsd: null },
    ])
    await seedDecisions(other.workspaceId, [{ modelCalled: true, modelCostUsd: 1.5 }])

    const projects = await listProjects()

    for (const workspaceId of [fixture.workspaceId, other.workspaceId]) {
      const spend = await workspaceSpend(workspaceId)
      expect(projects.find((p) => p.id === workspaceId)?.spend).toBeCloseTo(spend.spentUsd)
    }
    // And the second project's own row is only its own money: 1.50, on top of no runs at all.
    expect(projects.find((p) => p.id === other.workspaceId)?.spend).toBeCloseTo(1.5)
  })

  it('leaves a project with no Supervisor decisions exactly where it was', async (): Promise<void> => {
    const project = (await listProjects()).find((p) => p.id === fixture.workspaceId)

    expect(project?.spend).toBeCloseTo(EXPECTED_SPEND)
    expect((await workspaceSpend(fixture.workspaceId)).spentUsd).toBeCloseTo(EXPECTED_SPEND)
  })
})
