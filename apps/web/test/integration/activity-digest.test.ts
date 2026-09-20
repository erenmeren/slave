import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildActivityDigest } from '../../src/server/activityDigest.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
}

/** The same shape `activity-history.test.ts`'s own `seed` builds -- one workspace, one team, one
 *  seated worker, one task -- reused rather than imported (that file's `seed` is private). */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Digest Fixture',
      repoPath: '/tmp/activity-digest-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Alex' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', personId: person.id } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Retry the charge',
      description: 'x',
      status: 'done',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id }
}

/** `appendEvent` stamps `ts` itself, so a test that needs two DAYS has to move the row afterwards --
 *  `supervisor-threads.test.ts`'s own `backdate`, copied rather than imported (private to that file). */
async function backdate(workspaceId: string, seq: number, ts: Date): Promise<void> {
  await prisma.executionEvent.updateMany({ where: { workspaceId, seq }, data: { ts } })
}

describe('buildActivityDigest', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('groups two days newest first, items newest first, every sentence readable, and names the task and the actor on the task.done row', async (): Promise<void> => {
    const { workspaceId, slaveId, taskId } = fixture

    const created = await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId,
      actor: 'human',
      payload: { title: 'Retry the charge' },
    })
    const started = await appendEvent({
      type: 'task.started',
      workspaceId,
      taskId,
      slaveId,
      actor: 'slave',
      payload: { title: 'Retry the charge' },
    })
    const runSucceeded = await appendEvent({
      type: 'run.succeeded',
      workspaceId,
      taskId,
      slaveId,
      actor: 'slave',
      payload: { numTurns: 3, costUsd: 0.4 },
    })
    const done = await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId,
      slaveId,
      actor: 'slave',
      payload: { branch: 'feature/retry-charge' },
    })
    const tripped = await appendEvent({
      type: 'guardrail.tripped',
      workspaceId,
      taskId,
      actor: 'system',
      payload: { guardrail: 'budget', detail: 'over budget' },
    })
    void runSucceeded
    void done
    void tripped

    // Backdate the two oldest rows to yesterday, so the digest genuinely groups two calendar days.
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    await backdate(workspaceId, Number(created.seq), yesterday)
    await backdate(workspaceId, Number(started.seq), yesterday)

    const days = await buildActivityDigest(workspaceId)

    expect(days).not.toBeNull()
    expect(days).toHaveLength(2)
    // Newest day first: today's id (a later calendar date) sorts after yesterday's lexically.
    expect((days![0]!.id > days![1]!.id)).toBe(true)
    expect(days![0]!.when).toBe('today')
    expect(days![1]!.when).toBe('yesterday')

    // Newest item first within a day.
    expect(days![0]!.items.map((item) => item.type)).toEqual(['guardrail.tripped', 'task.done', 'run.succeeded'])
    expect(days![1]!.items.map((item) => item.type)).toEqual(['task.started', 'task.created'])

    for (const day of days!) {
      for (const item of day.items) {
        expect(item.sentence).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
      }
    }

    const doneItem = days![0]!.items.find((item) => item.type === 'task.done')
    expect(doneItem?.sentence).toContain('Retry the charge')
    expect(doneItem?.sentence).toContain('Alex')
    expect(doneItem?.actorName).toBe('Alex')
    expect(doneItem?.workspaceId).toBe(workspaceId)
  })

  it('answers null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildActivityDigest('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('answers an empty list for a workspace with no history at all', async (): Promise<void> => {
    expect(await buildActivityDigest(fixture.workspaceId)).toEqual([])
  })
})
