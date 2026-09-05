import { prisma } from '@slave-of-ai/db/client'
import { SEED_WORKSPACE_ID } from '@slave-of-ai/db'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildAnalytics } from '../../src/server/analytics.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout', repoPath: '/tmp/analytics-fixture', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

describe('buildAnalytics', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns seven days oldest first, zero-filled, even with no runs at all', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.series).toHaveLength(7)
    expect(snapshot.series.every((d) => d.succeeded === 0 && d.failed === 0)).toBe(true)
    const days = snapshot.series.map((d) => d.day)
    expect([...days].sort()).toEqual(days)
  })

  it('buckets succeeded and failed runs by the day they concluded', async (): Promise<void> => {
    for (const [status, terminalAt] of [
      ['succeeded', daysAgo(1)],
      ['succeeded', daysAgo(1)],
      ['failed', daysAgo(1)],
      ['succeeded', daysAgo(3)],
      ['succeeded', daysAgo(30)], // outside the window
    ] as const) {
      await prisma.agentRun.create({
        data: { agentId: fixture.agentId, status, provider: 'claude_code', terminalAt, endedAt: terminalAt },
      })
    }
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const total = snapshot.series.reduce((n, d) => n + d.succeeded + d.failed, 0)
    expect(total).toBe(4)
    const busiest = snapshot.series.find((d) => d.succeeded + d.failed === 3)
    expect(busiest?.succeeded).toBe(2)
    expect(busiest?.failed).toBe(1)
  })

  it('produces six KPIs in a fixed order', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis.map((k) => k.label)).toEqual([
      'Task success rate',
      'Avg run duration',
      'Spend',
      'Tool calls',
      'Pauses',
      'Active agents',
    ])
  })

  it('shows the unknown mark rather than a rate when nothing has concluded', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis[0]?.value).toBe('—')
    expect(snapshot.kpis[1]?.value).toBe('—')
  })

  it('computes task success rate as done / (done + failed), ignoring tasks in other states', async (): Promise<void> => {
    const makeTask = (status: 'done' | 'failed' | 'running'): Promise<{ id: string }> =>
      prisma.task.create({
        data: { workspaceId: fixture.workspaceId, title: 't', description: 'd', status, maxAttempts: 3 },
      })
    await makeTask('done')
    await makeTask('done')
    await makeTask('done')
    await makeTask('failed')
    await makeTask('running') // must not affect the denominator
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const rate = snapshot.kpis.find((k) => k.label === 'Task success rate')
    expect(rate?.value).toBe('75%')
    expect(rate?.note).toBe('3 of 4')
  })

  it('reports known spend and says how many runs nobody could measure', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', costUsd: 1.5, terminalAt: new Date(), endedAt: new Date() },
    })
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'cursor', costUsd: null, terminalAt: new Date(), endedAt: new Date() },
    })
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const spend = snapshot.kpis.find((k) => k.label === 'Spend')
    expect(spend?.value).toBe('$1.50')
    expect(spend?.note).toBe('1 run unmeasured')
  })

  it('counts pauses from the event log, not from a run column', async (): Promise<void> => {
    const run = await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'paused', provider: 'claude_code' } })
    for (let i = 0; i < 2; i += 1) {
      await appendEvent({
        type: 'run.paused',
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'system',
        payload: { atStep: 1 },
      })
    }
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis.find((k) => k.label === 'Pauses')?.value).toBe('2')
  })

  it('counts active agents, not their runs: one agent with two non-terminal runs reads 1', async (): Promise<void> => {
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working', provider: 'claude_code' } })
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'paused', provider: 'claude_code' } })
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis.find((k) => k.label === 'Active agents')?.value).toBe('1')
  })

  it('sums an agent tokens only over runs that reported them, and says null when none did', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', tokensIn: 10, tokensOut: 90, terminalAt: new Date(), endedAt: new Date() },
    })
    expect((await buildAnalytics(fixture.workspaceId)).perAgent[0]?.tokens).toBe(100)

    await prisma.agentRun.deleteMany({})
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'cursor', tokensIn: null, tokensOut: null, terminalAt: new Date(), endedAt: new Date() },
    })
    expect((await buildAnalytics(fixture.workspaceId)).perAgent[0]?.tokens).toBeNull()
  })

  it('reports a null success rate and duration for an agent with no terminal run', async (): Promise<void> => {
    const row = (await buildAnalytics(fixture.workspaceId)).perAgent[0]
    expect(row?.runs).toBe(0)
    expect(row?.successPct).toBeNull()
    expect(row?.avgDurationMs).toBeNull()
  })

  it('scopes to a workspace, and covers every workspace when given null', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    const otherAgent = await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Bea', role: 'qa' } })
    await prisma.agentRun.create({
      data: { agentId: otherAgent.id, status: 'succeeded', provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })

    expect((await buildAnalytics(fixture.workspaceId)).perAgent.map((r) => r.name)).toEqual(['Alex'])
    expect((await buildAnalytics(null)).perAgent.map((r) => r.name).sort()).toEqual(['Alex', 'Bea'])
  })

  it('marks only the seeded workspace as seeded, never a fresh workspace or the all-workspaces view', async (): Promise<void> => {
    expect((await buildAnalytics(fixture.workspaceId)).seeded).toBe(false)
    expect((await buildAnalytics(null)).seeded).toBe(false)

    await prisma.workspace.create({
      data: { id: SEED_WORKSPACE_ID, name: 'Checkout Platform', repoPath: '/tmp/seed-fixture', verifyCommands: ['true'], setupCommands: [] },
    })
    expect((await buildAnalytics(SEED_WORKSPACE_ID)).seeded).toBe(true)
  })
})
