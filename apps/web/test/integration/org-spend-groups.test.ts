import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listProjects } from '../../src/server/org.js'

/**
 * Equivalence test for Task 13 (M17): `listProjects`' spend path must produce the SAME `spend` /
 * `unmeasuredRuns` numbers whether it is computed from the whole-table `findMany` + `sumSpend`
 * pass (the pre-rewrite implementation) or from `agentRun.groupBy` + `sumSpendFromGroups` (the
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
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Spend Groups Fixture',
      repoPath: '/tmp/org-spend-groups-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, teamId: team.id, agentId: agent.id }
}

const t0 = new Date('2026-02-01T00:00:00Z')
const plusMs = (ms: number): Date => new Date(t0.getTime() + ms)

/** The five rule-branch rows, hand-mapped to their contribution below. */
async function seedRuleBranchRuns(fixture: Fixture): Promise<void> {
  await prisma.agentRun.createMany({
    data: [
      // 1. Unmeasured: spawned (provider set), finished (terminal status), no cost reported.
      //    -> known += 0, unmeasuredRuns += 1
      {
        agentId: fixture.agentId,
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
        agentId: fixture.agentId,
        status: 'working',
        provider: 'claude_code',
        costUsd: null,
        startedAt: t0,
      },
      // 3. Pre-M12-shaped row: real cost, null provider (the column did not exist yet).
      //    Its money stays in `known`; the null provider means it can never qualify as unmeasured.
      //    -> known += 2.00, unmeasuredRuns += 0
      {
        agentId: fixture.agentId,
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
        agentId: fixture.agentId,
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
        agentId: fixture.agentId,
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
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
