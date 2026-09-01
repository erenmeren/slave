import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listWorkers } from '../../src/server/org.js'

/**
 * Equivalence test for Task 12 (M19, C5): `listWorkers`' derived facts (`costUsd`/`unmeasuredRuns`,
 * `tokens`, live `provider`) must come out the SAME whether they are computed from the
 * whole-history `findMany` + in-memory reduce (the pre-rewrite implementation) or from
 * `agentRun.groupBy` + a separate bounded live-run query (the rewrite). This file is run TWICE
 * against the same fixture -- once before the rewrite (the equivalence claim) and once after -- and
 * must pass unchanged both times, the same method `org-spend-groups.test.ts` (M17 Task 13) used.
 *
 * Three agents, one per group of rule branches the task brief lists:
 *
 * - Alex: (a) an unmeasured terminal run, (b) an in-flight run with a provider, (c) a pre-M12 row
 *   (real cost, null provider), (d) a measured zero, (e) an ordinary measured run with tokens, and
 *   (e2) a measured run reporting ONLY `tokensIn` (`tokensOut` null) -- review fix round 1: the
 *   matrix must isolate a single-column token report, not just "both set" and "both null", so a
 *   `tokens` computation built on `_sum.tokensIn` and `_sum.tokensOut` independently (rather than
 *   treating the pair as one unit) is actually exercised. Branches (a)-(e) are the same five
 *   `org-spend-groups.test.ts` seeds for `listProjects`; (e) and (e2) between them give `tokens`
 *   and live `provider` (read off (b), Alex's only non-terminal run) something to compute over.
 * - Blake: (f) an agent whose runs ALL omit tokens -- `tokens` must be `null`, not `0`.
 * - Casey: (g) an agent with TWO non-terminal runs at different `startedAt` -- live `provider`
 *   must be the NEWER one's, proving the "first row per agent, ordered by startedAt desc" rule
 *   rather than an incidental array-order artifact.
 *
 * Expected values below are computed BY HAND from the seeded rows, not derived from either
 * implementation.
 */

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly alexId: string
  readonly blakeId: string
  readonly caseyId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Workers Groups Fixture',
      repoPath: '/tmp/org-workers-groups-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const alex = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const blake = await prisma.agent.create({ data: { teamId: team.id, name: 'Blake', role: 'backend' } })
  const casey = await prisma.agent.create({ data: { teamId: team.id, name: 'Casey', role: 'backend' } })
  return { workspaceId: workspace.id, teamId: team.id, alexId: alex.id, blakeId: blake.id, caseyId: casey.id }
}

const t0 = new Date('2026-02-01T00:00:00Z')
const plusMs = (ms: number): Date => new Date(t0.getTime() + ms)

async function seedRuleBranchRuns(fixture: Fixture): Promise<void> {
  await prisma.agentRun.createMany({
    data: [
      // Alex (a): unmeasured -- spawned (provider set), finished (terminal), no cost reported.
      //   -> known += 0, unmeasuredRuns += 1; does not report tokens.
      {
        agentId: fixture.alexId,
        status: 'failed',
        provider: 'claude_code',
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Alex (b): in-flight -- non-terminal status, no cost yet. Alex's ONLY non-terminal run, so
      //   live `provider` must read off this one.
      //   -> known += 0, unmeasuredRuns += 0
      {
        agentId: fixture.alexId,
        status: 'working',
        provider: 'claude_code',
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
      },
      // Alex (c): pre-M12-shaped row -- real cost, null provider (the column did not exist yet).
      //   Its money stays in `known`; the null provider means it can never qualify as unmeasured.
      //   -> known += 2.00, unmeasuredRuns += 0
      {
        agentId: fixture.alexId,
        status: 'succeeded',
        provider: null,
        costUsd: 2.0,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Alex (d): measured zero -- a run that genuinely cost nothing is a MEASURED zero, not a hole.
      //   -> known += 0, unmeasuredRuns += 0
      {
        agentId: fixture.alexId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 0,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Alex (e): ordinary measured run, reporting both token columns.
      //   -> known += 1.25, unmeasuredRuns += 0; tokens += 1000 + 500 = 1500
      {
        agentId: fixture.alexId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 1.25,
        tokensIn: 1000,
        tokensOut: 500,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Alex (e2): a measured run reporting ONLY `tokensIn` -- `tokensOut` null. Must still count
      //   toward `tokens` (300 once, not skipped for the null half) without disturbing
      //   `unmeasuredRuns` (it carries a real cost, so it is a measured run, not a hole).
      //   -> known += 0.75, unmeasuredRuns += 0; tokens += 300 + 0 = 300
      {
        agentId: fixture.alexId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 0.75,
        tokensIn: 300,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Blake (f): two measured runs, NEITHER reports tokens -- `tokens` must be `null`, never `0`.
      //   -> known += 5.00 + 3.50 = 8.50, unmeasuredRuns += 0
      {
        agentId: fixture.blakeId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 5.0,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      {
        agentId: fixture.blakeId,
        status: 'succeeded',
        provider: 'claude_code',
        costUsd: 3.5,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
        endedAt: plusMs(60_000),
        terminalAt: plusMs(60_000),
      },
      // Casey (g): TWO non-terminal runs at different `startedAt`. Both count toward neither
      //   `unmeasuredRuns` (in flight is not unmeasured) nor `tokens` (neither reports). Live
      //   `provider` must be the NEWER row's ('cursor'), not the older one's ('claude_code') and
      //   not whichever happens to insert first.
      {
        agentId: fixture.caseyId,
        status: 'working',
        provider: 'claude_code',
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        startedAt: t0,
      },
      {
        agentId: fixture.caseyId,
        status: 'starting',
        provider: 'cursor',
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        startedAt: plusMs(120_000),
      },
    ],
  })
}

// By hand, Alex: known = 0 (a) + 0 (b) + 2.00 (c) + 0 (d) + 1.25 (e) + 0.75 (e2) = 4.00;
// unmeasuredRuns: only (a) qualifies (provider written, terminal, no cost) = 1; tokens: (e)
// reports 1000+500 = 1500, (e2) reports 300+0 = 300 (tokensOut null contributes 0, not skipped) ->
// 1800; live provider: Alex's only non-terminal run is (b) -> 'claude_code'.
const ALEX_EXPECTED = { costUsd: 4.0, unmeasuredRuns: 1, tokens: 1800, provider: 'claude_code' as const }

// By hand, Blake: known = 5.00 + 3.50 = 8.50; unmeasuredRuns = 0 (both measured); tokens: neither
// run reports -> null; live provider: no non-terminal run -> null.
const BLAKE_EXPECTED = { costUsd: 8.5, unmeasuredRuns: 0, tokens: null, provider: null }

// By hand, Casey: known = 0; unmeasuredRuns = 0 (both non-terminal, in flight is not unmeasured);
// tokens: neither reports -> null; live provider: newer of the two by startedAt is the second row
// ('cursor').
const CASEY_EXPECTED = { costUsd: 0, unmeasuredRuns: 0, tokens: null, provider: 'cursor' as const }

describe('listWorkers derived-facts equivalence', () => {
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

  it('computes the exact hand-computed costUsd, unmeasuredRuns, tokens and live provider over every rule branch', async (): Promise<void> => {
    const workers = await listWorkers()
    const alex = workers.find((w) => w.agentId === fixture.alexId)
    const blake = workers.find((w) => w.agentId === fixture.blakeId)
    const casey = workers.find((w) => w.agentId === fixture.caseyId)

    expect(alex?.costUsd).toBeCloseTo(ALEX_EXPECTED.costUsd)
    expect(alex?.unmeasuredRuns).toBe(ALEX_EXPECTED.unmeasuredRuns)
    expect(alex?.tokens).toBe(ALEX_EXPECTED.tokens)
    expect(alex?.provider).toBe(ALEX_EXPECTED.provider)

    expect(blake?.costUsd).toBeCloseTo(BLAKE_EXPECTED.costUsd)
    expect(blake?.unmeasuredRuns).toBe(BLAKE_EXPECTED.unmeasuredRuns)
    expect(blake?.tokens).toBe(BLAKE_EXPECTED.tokens)
    expect(blake?.provider).toBe(BLAKE_EXPECTED.provider)

    expect(casey?.costUsd).toBeCloseTo(CASEY_EXPECTED.costUsd)
    expect(casey?.unmeasuredRuns).toBe(CASEY_EXPECTED.unmeasuredRuns)
    expect(casey?.tokens).toBe(CASEY_EXPECTED.tokens)
    expect(casey?.provider).toBe(CASEY_EXPECTED.provider)
  })
})
