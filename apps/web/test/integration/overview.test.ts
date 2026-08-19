import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildOverviewSnapshot } from '../../src/server/overview.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/overview-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, agentId: agent.id, taskId: task.id }
}

describe('buildOverviewSnapshot', () => {
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

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildOverviewSnapshot('nope')).toBeNull()
  })

  it('derives the agent status from its active run with the domain function', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'pause_requested' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // 'pausing', not 'pause_requested': ADR 0002's derivation is the only translator, and the UI
    // rendering raw run statuses would drift the moment the domain adds a status.
    expect(snapshot?.agents[0]?.status).toBe('pausing')
    expect(snapshot?.agents[0]?.taskTitle).toBe('Add the thing')
    expect(snapshot?.agents[0]?.runId).toBe(run.id)
  })

  it('reports an agent with no live run as idle with no task', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // A finished run must not keep its agent looking busy — the derivation maps terminal to idle,
    // and the card must not resurrect the dead run's task title either.
    expect(snapshot?.agents[0]?.status).toBe('idle')
    expect(snapshot?.agents[0]?.taskTitle).toBeNull()
    expect(snapshot?.agents[0]?.actionLine).toBeNull()
  })

  it('sums budget spend across every run regardless of status', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 1.5 },
    })
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'failed',
        costUsd: 2.5,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // loadWorld's rule (M3): money is spent whether or not the run is still going. A gauge that
    // forgot failed runs would show a workspace under budget while the bank account disagrees.
    expect(snapshot?.workspace.spentUsd).toBeCloseTo(4.0)
    expect(snapshot?.workspace.budgetUsd).toBe(100)
  })

  it('seeds the action line from the latest run.tool_call event', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })
    for (const summary of ['Read README.md', 'Write note1.txt']) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'agent',
        payload: { name: summary.split(' ')[0] ?? '', summary },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // The latest one, not the first: a card that opens on a stale line contradicts the live line
    // the stream is about to draw over it.
    expect(snapshot?.agents[0]?.actionLine).toBe('Write note1.txt')
  })

  it('counts tasks into the strip buckets', async (): Promise<void> => {
    for (const status of ['ready', 'blocked', 'done', 'failed', 'rework'] as const) {
      await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: status,
          description: 'x',
          status,
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // Active = ready/running/verifying/rework (spec §5). The seeded fixture task is `running`.
    expect(snapshot?.tasks).toEqual({ active: 3, blocked: 1, done: 1, failed: 1 })
  })

  it('carries the halt verbatim', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open (PreToolUse:Write exited 127)', haltedAt: new Date() },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.haltedReason).toContain('PreToolUse:Write')
    expect(snapshot?.workspace.haltedAt).not.toBeNull()
  })

  it('does not leak another workspace\'s agents or tasks', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend' } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents.map((a) => a.name)).toEqual(['Alex'])
  })
})
