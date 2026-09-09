import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { releaseTaskAfterFailure } from '../../src/taskRelease.js'

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
}

/**
 * A minimal task, without the run/slave/adapter machinery `pump.test.ts` and `tick.test.ts` carry
 * -- `releaseTaskAfterFailure` only ever reads/writes `Task`, so the fixture stays that small.
 */
async function seed(options: { readonly attempt?: number; readonly maxAttempts?: number; readonly activeRunId: string }): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'the task under release',
      description: 'hosts the run being released',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: options.maxAttempts ?? workspace.maxAttempts,
      attempt: options.attempt ?? 0,
    },
  })
  const run = await prisma.slaveRun.create({
    data: { id: options.activeRunId, taskId: task.id, slaveId: slave.id, status: 'starting' },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })
  return { workspaceId: workspace.id, taskId: task.id }
}

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('releaseTaskAfterFailure', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('increments the attempt and parks the task, clearing activeRunId', async (): Promise<void> => {
    const runId = 'r-owns-it'
    const { taskId } = await seed({ attempt: 0, maxAttempts: 3, activeRunId: runId })

    const release = await releaseTaskAfterFailure({ id: taskId, maxAttempts: 3 }, runId, 'rework')

    expect(release).toEqual({ attempt: 1, exhausted: false })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.attempt).toBe(1)
    expect(task.status).toBe('rework')
    expect(task.activeRunId).toBeNull()
  })

  it('parks failed and reports exhausted once the incremented attempt reaches maxAttempts', async (): Promise<void> => {
    const runId = 'r-last-try'
    const { taskId } = await seed({ attempt: 0, maxAttempts: 1, activeRunId: runId })

    const release = await releaseTaskAfterFailure({ id: taskId, maxAttempts: 1 }, runId, 'rework')

    expect(release).toEqual({ attempt: 1, exhausted: true })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('failed')
    expect(task.activeRunId).toBeNull()
  })

  it('touches nothing and reports exhausted: false when it lost the race for activeRunId (M35 final review, Important 2)', async (): Promise<void> => {
    // The task is ALREADY at its ceiling under someone else's run -- a stale read of `attempt`
    // alone would call this exhausted. But `runId` below names a run that does not own the task
    // (a cancel or a sweep won first), so both writes inside the transaction must match zero rows,
    // and the reported `exhausted` must come from the park write's own outcome, not that stale read.
    const owner = 'r-owner'
    const { taskId } = await seed({ attempt: 1, maxAttempts: 1, activeRunId: owner })

    const release = await releaseTaskAfterFailure({ id: taskId, maxAttempts: 1 }, 'r-not-the-owner', 'rework')

    expect(release).toEqual({ attempt: 1, exhausted: false })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    // Untouched: still owned by the real run, still at its pre-call attempt count, still `running`.
    expect(task.activeRunId).toBe(owner)
    expect(task.attempt).toBe(1)
    expect(task.status).toBe('running')
  })

  it('is idempotent: replaying the same runId after the first release charges nothing a second time', async (): Promise<void> => {
    const runId = 'r-replayed'
    const { taskId } = await seed({ attempt: 0, maxAttempts: 3, activeRunId: runId })

    const first = await releaseTaskAfterFailure({ id: taskId, maxAttempts: 3 }, runId, 'rework')
    expect(first).toEqual({ attempt: 1, exhausted: false })

    const second = await releaseTaskAfterFailure({ id: taskId, maxAttempts: 3 }, runId, 'rework')
    // `activeRunId` is already null after the first call, so the second finds nothing to claim.
    expect(second).toEqual({ attempt: 1, exhausted: false })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.attempt).toBe(1)
    expect(task.status).toBe('rework')
  })
})
