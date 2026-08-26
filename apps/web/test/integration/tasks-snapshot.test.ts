import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTasksSnapshot } from '../../src/server/tasks.js'
import { GET as tasksGET } from '../../src/app/api/w/[workspaceId]/tasks/route.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/tasks-snapshot-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('buildTasksSnapshot', () => {
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

  it('returns every task with its runs newest-first and checkpoint summaries', async (): Promise<void> => {
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Add the thing',
        description: 'x',
        status: 'blocked',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const olderRun = await prisma.agentRun.create({
      data: {
        taskId: seeded.id,
        agentId: fixture.agentId,
        status: 'failed',
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        terminalAt: new Date('2026-08-01T01:00:00.000Z'),
        endedAt: new Date('2026-08-01T01:00:00.000Z'),
      },
    })
    const newerRun = await prisma.agentRun.create({
      data: {
        taskId: seeded.id,
        agentId: fixture.agentId,
        status: 'paused',
        startedAt: new Date('2026-08-02T00:00:00.000Z'),
        pausedAtStep: 3,
      },
    })
    await prisma.checkpoint.create({
      data: {
        runId: newerRun.id,
        sessionId: 'session-abc',
        worktreePath: '/tmp/tasks-snapshot-fixture/.aiteamos/worktrees/T-abcdef12',
        pauseFlagPath: '/tmp/tasks-snapshot-fixture/.aiteamos/runs/pause.flag',
        settingsPath: '/tmp/tasks-snapshot-fixture/.aiteamos/runs/settings.json',
        hookPath: '/tmp/tasks-snapshot-fixture/scripts/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@aiteamos.local',
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        dirtyFiles: ['src/index.ts', 'src/other.ts'],
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === seeded.id)

    expect(task?.runs[0]?.checkpoint?.pausedAtStep).toBe(3)
    expect(task?.runs[0]?.checkpoint?.dirtyFileCount).toBe(2)
    expect(task?.runs.map((r) => r.id)).toEqual([newerRun.id, olderRun.id])
  })

  it("keeps a run's unknown cost unknown rather than reporting it as $0.00", async (): Promise<void> => {
    // M12 Task 9 / ruling R3. The comment this replaces said `$0.00` was chosen here "rather than
    // widening this DTO to a tri-state" -- widening it is exactly what spec Decision 6 asks for,
    // and the panel now renders the unknown mark the Roster already uses.
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Unmeasured work',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.agentRun.create({
      data: { taskId: seeded.id, agentId: fixture.agentId, status: 'succeeded', costUsd: null },
    })
    await prisma.agentRun.create({
      data: {
        taskId: seeded.id,
        agentId: fixture.agentId,
        status: 'succeeded',
        costUsd: 0.42,
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === seeded.id)

    expect(task?.runs.map((r) => r.costUsd)).toEqual([null, 0.42])
  })

  it('names the live run agent as assignee and leaves finished tasks unassigned', async (): Promise<void> => {
    const runningTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Live task',
        description: 'x',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const liveRun = await prisma.agentRun.create({
      data: { taskId: runningTask.id, agentId: fixture.agentId, status: 'working' },
    })
    await prisma.task.update({ where: { id: runningTask.id }, data: { activeRunId: liveRun.id } })

    const doneTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Finished task',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.agentRun.create({
      data: {
        taskId: doneTask.id,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)

    expect(snapshot?.tasks.find((t) => t.id === runningTask.id)?.assigneeName).toBe('Alex')
    expect(snapshot?.tasks.find((t) => t.id === doneTask.id)?.assigneeName).toBeNull()
  })

  it('returns null for an unknown workspace', async (): Promise<void> => {
    expect(await buildTasksSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('the route serves the snapshot and 404s an unknown workspace', async (): Promise<void> => {
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Add the thing',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })

    const ok = await tasksGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).tasks.length).toBeGreaterThan(0)

    const missing = await tasksGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
    })
    expect(missing.status).toBe(404)
  })
})
