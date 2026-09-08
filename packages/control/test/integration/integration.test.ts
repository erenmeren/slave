import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { confirmIntegration } from '../../src/integration.js'
import { refusalText } from '../../src/refusal.js'

interface Fixture {
  readonly workspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspaceId: workspace.id }
}

async function makeTask(
  workspaceId: string,
  overrides: { readonly status?: 'backlog' | 'done'; readonly integratedAt?: Date | null } = {},
): Promise<{ readonly id: string }> {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Add the thing',
      description: 'make it work',
      status: overrides.status ?? 'done',
      maxAttempts: 5,
      integratedAt: overrides.integratedAt ?? null,
    },
  })
  return { id: task.id }
}

describe('confirmIntegration', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    ;({ workspaceId } = await seed())
  })

  it('stamps integratedAt and emits task.integrated on a done, unintegrated task', async (): Promise<void> => {
    const task = await makeTask(workspaceId, { status: 'done', integratedAt: null })

    const result = await confirmIntegration(task.id)
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.integratedAt).not.toBeNull()

    const events = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_integrated' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('human')
  })

  it('refuses a task that does not exist', async (): Promise<void> => {
    const result = await confirmIntegration('does-not-exist')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'task_not_found', taskId: 'does-not-exist' })
    expect(refusalText(result.error)).toContain('no task with id')
  })

  it('refuses a task that has not reached done yet', async (): Promise<void> => {
    const task = await makeTask(workspaceId, { status: 'backlog', integratedAt: null })

    const result = await confirmIntegration(task.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'task_not_done', taskId: task.id, status: 'backlog' })
    expect(refusalText(result.error)).toContain('only a done task can be confirmed integrated')

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.integratedAt).toBeNull()
  })

  it('refuses a task that is already integrated', async (): Promise<void> => {
    const already = new Date('2026-09-01T00:00:00.000Z')
    const task = await makeTask(workspaceId, { status: 'done', integratedAt: already })

    const result = await confirmIntegration(task.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'already_integrated', taskId: task.id })
    expect(refusalText(result.error)).toContain('already integrated')

    // Unchanged -- the original stamp survives a refused re-confirmation.
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.integratedAt?.toISOString()).toBe(already.toISOString())

    expect(await prisma.executionEvent.count({ where: { taskId: task.id, type: 'task_integrated' } })).toBe(0)
  })
})
