import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

/**
 * `maxAttempts` is deliberately 5, not the schema default of 3. A workspace left on the default
 * makes the "carries maxAttempts from the workspace" assertion below indistinguishable from the
 * column default doing the work, which is the same confound the seed carries a warning about
 * (`packages/db/src/seed.ts`). Do not "tidy" this back to 3.
 */
const WORKSPACE_MAX_ATTEMPTS = 5

async function seedWorkspace(): Promise<{ workspaceId: string; agentId: string; maxAttempts: number }> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommand: 'npm test',
      maxAttempts: WORKSPACE_MAX_ATTEMPTS,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  return { workspaceId: workspace.id, agentId: agent.id, maxAttempts: workspace.maxAttempts }
}

describe('work tables', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Approval", "AgentMessage", "Artifact", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('defaults a new task to backlog and carries maxAttempts from the workspace', async () => {
    const { workspaceId, maxAttempts } = await seedWorkspace()

    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts },
    })

    expect(task.status).toBe('backlog')
    expect(task.attempt).toBe(0)
    // 5, the workspace's value — and specifically not 3, the column default, which is what this
    // assertion used to be satisfied by no matter where the number came from.
    expect(task.maxAttempts).toBe(WORKSPACE_MAX_ATTEMPTS)
    expect(task.maxAttempts).not.toBe(3)
  })

  it('refuses a task row with no maxAttempts', async () => {
    const { workspaceId } = await seedWorkspace()

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" (id, "workspaceId", title, description) VALUES (gen_random_uuid(), '${workspaceId}', 't', 'd')`,
      ),
    ).rejects.toThrow()
  })

  it('defaults a run to implementation kind with no pause reason', async () => {
    const { workspaceId, agentId, maxAttempts } = await seedWorkspace()
    const task = await prisma.task.create({
      data: { workspaceId, title: 't', description: 'd', maxAttempts },
    })

    const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId } })

    expect(run.kind).toBe('implementation')
    expect(run.status).toBe('starting')
    expect(run.pauseReason).toBeNull()
    expect(run.toolCalls).toBe(0)
  })

  it('stores a review run alongside an implementation run for the same task', async () => {
    const { workspaceId, agentId, maxAttempts } = await seedWorkspace()
    const task = await prisma.task.create({
      data: { workspaceId, title: 't', description: 'd', maxAttempts },
    })

    await prisma.agentRun.create({ data: { taskId: task.id, agentId, kind: 'implementation' } })
    await prisma.agentRun.create({ data: { taskId: task.id, agentId, kind: 'review' } })

    const kinds = await prisma.agentRun.findMany({ where: { taskId: task.id }, select: { kind: true } })
    expect(kinds.map((r) => r.kind).sort()).toEqual(['implementation', 'review'])
  })

  it('records a dependency between two tasks', async () => {
    const { workspaceId, maxAttempts } = await seedWorkspace()
    const first = await prisma.task.create({
      data: { workspaceId, title: 'schema', description: 'd', maxAttempts },
    })
    const second = await prisma.task.create({
      data: { workspaceId, title: 'api', description: 'd', maxAttempts },
    })

    await prisma.taskDependency.create({ data: { taskId: second.id, dependsOnTaskId: first.id } })

    const found = await prisma.taskDependency.findMany({ where: { taskId: second.id } })
    expect(found[0]?.dependsOnTaskId).toBe(first.id)
  })
})
