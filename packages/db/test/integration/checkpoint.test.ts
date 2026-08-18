import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedRun(): Promise<{ workspaceId: string; taskId: string; agentId: string; runId: string }> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'w',
      repoPath: '/tmp/repo',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Do the thing',
      description: 'Do the thing well',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id },
  })
  return { workspaceId: workspace.id, taskId: task.id, agentId: agent.id, runId: run.id }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "AgentRun", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Checkpoint', () => {
  it('stores everything ADR 0001 requires to resume a run', async (): Promise<void> => {
    const { runId } = await seedRun()

    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-123',
        worktreePath: '/tmp/worktrees/run-1',
        pauseFlagPath: '/tmp/worktrees/run-1/.aiteamos-pause',
        lastToolUseId: 'toolu_01ABC',
        lastToolName: 'Edit',
        numTurns: 7,
        deniedToolUseIds: ['toolu_01DEF', 'toolu_01GHI'],
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        dirtyFiles: ['src/index.ts', 'src/util.ts'],
        cumulativeCostUsd: 1.2345,
        cumulativeTokens: 45210,
        pauseReason: 'human',
        requestedBy: 'erenaltan@gmail.com',
      },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })

    expect(found.id).toBe(created.id)
    expect(found.runId).toBe(runId)
    expect(found.sessionId).toBe('session-123')
    expect(found.worktreePath).toBe('/tmp/worktrees/run-1')
    expect(found.pauseFlagPath).toBe('/tmp/worktrees/run-1/.aiteamos-pause')
    expect(found.lastToolUseId).toBe('toolu_01ABC')
    expect(found.lastToolName).toBe('Edit')
    expect(found.numTurns).toBe(7)
    expect(found.deniedToolUseIds).toEqual(['toolu_01DEF', 'toolu_01GHI'])
    expect(found.headCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(found.dirtyFiles).toEqual(['src/index.ts', 'src/util.ts'])
    expect(found.cumulativeCostUsd).toBe(1.2345)
    expect(found.cumulativeTokens).toBe(45210)
    expect(found.pauseReason).toBe('human')
    expect(found.requestedBy).toBe('erenaltan@gmail.com')
    expect(found.ts).toBeInstanceOf(Date)
  })

  it('allows the nullable fields to stay null for a checkpoint with no denials yet', async (): Promise<void> => {
    const { runId } = await seedRun()

    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-456',
        worktreePath: '/tmp/worktrees/run-2',
        pauseFlagPath: '/tmp/worktrees/run-2/.aiteamos-pause',
        deniedToolUseIds: [],
        headCommit: 'deadbeef',
        dirtyFiles: [],
      },
    })

    expect(created.lastToolUseId).toBeNull()
    expect(created.lastToolName).toBeNull()
    expect(created.pauseReason).toBeNull()
    expect(created.requestedBy).toBeNull()
    expect(created.numTurns).toBe(0)
    expect(created.cumulativeCostUsd).toBe(0)
    expect(created.cumulativeTokens).toBe(0)
  })

  it('cascades deletion from its run', async (): Promise<void> => {
    const { runId } = await seedRun()
    await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-789',
        worktreePath: '/tmp/worktrees/run-3',
        pauseFlagPath: '/tmp/worktrees/run-3/.aiteamos-pause',
        deniedToolUseIds: [],
        headCommit: 'cafef00d',
        dirtyFiles: [],
      },
    })

    await prisma.agentRun.delete({ where: { id: runId } })

    expect(await prisma.checkpoint.count()).toBe(0)
  })
})

describe('Workspace command lists and halt state', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Workspace" RESTART IDENTITY CASCADE')
  })

  it('round-trips verifyCommands and setupCommands as ordered lists', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'w',
        repoPath: '/tmp/repo',
        verifyCommands: ['npm run build', 'npm test'],
        setupCommands: ['npm ci'],
      },
    })

    expect(workspace.verifyCommands).toEqual(['npm run build', 'npm test'])
    expect(workspace.setupCommands).toEqual(['npm ci'])
  })

  it('leaves a workspace halt state unset until it is explicitly halted, then round-trips it', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'w', repoPath: '/tmp/repo', verifyCommands: ['npm test'], setupCommands: [] },
    })

    expect(workspace.haltedReason).toBeNull()
    expect(workspace.haltedAt).toBeNull()

    const haltedAt = new Date()
    const halted = await prisma.workspace.update({
      where: { id: workspace.id },
      data: { haltedReason: 'pause gate failed on run r-1', haltedAt },
    })

    expect(halted.haltedReason).toBe('pause gate failed on run r-1')
    expect(halted.haltedAt).toEqual(haltedAt)
  })
})
