import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { setGoal } from '../../src/goal.js'

// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-goal-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
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
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
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

  it('stamps the event and the workspace with the principal, when one is given', async () => {
    const { workspace } = fixture
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant-for-this-test' } })

    const result = await setGoal(workspace.id, 'Ship the checkout redesign', { userId: user.id })

    expect(result.ok).toBe(true)

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goalSetByUserId).toBe(user.id)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.userId).toBe(user.id)
  })

  it('leaves goalSetByUserId and the event userId null with no principal', async () => {
    const { workspace } = fixture

    await setGoal(workspace.id, 'Ship the checkout redesign')

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goalSetByUserId).toBeNull()

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events[0]?.userId).toBeNull()
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
