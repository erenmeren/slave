import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { setGoal } from '../../src/goal.js'

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/does-not-matter',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspace: { id: workspace.id } }
}

describe('setGoal', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('sets the goal column and emits exactly one workspace.goal_set event with the goal in the payload', async () => {
    const { workspace } = fixture

    const result = await setGoal(workspace.id, 'Ship the checkout redesign')

    expect(result.ok).toBe(true)

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBe('Ship the checkout redesign')

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ goal: 'Ship the checkout redesign' })
    expect(events[0]?.actor).toBe('human')
  })

  it('refuses a blank goal, leaving the column untouched and emitting no event', async () => {
    const { workspace } = fixture

    const result = await setGoal(workspace.id, '   ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_goal' })

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBeNull()

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(0)
  })

  it('refuses an unknown workspace', async () => {
    const result = await setGoal('00000000-0000-4000-8000-000000000000', 'Ship it')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'workspace_not_found', workspaceId: '00000000-0000-4000-8000-000000000000' })
    }
  })

  it('succeeds on a workspace that already has a task', async () => {
    const { workspace } = fixture
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Existing task',
        description: 'already on the board',
        maxAttempts: 3,
      },
    })

    const result = await setGoal(workspace.id, 'Ship the checkout redesign')

    expect(result.ok).toBe(true)
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBe('Ship the checkout redesign')
  })
})
