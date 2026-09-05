import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedRun(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'w',
      repoPath: '/tmp/repo',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Do the thing',
      description: 'Do the thing well',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id },
  })
  return run.id
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "SlaveRun", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Checkpoint', () => {
  it('stores everything ADR 0001 requires to resume a run', async (): Promise<void> => {
    const runId = await seedRun()

    const ts = new Date('2026-08-18T12:34:56.000Z')
    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-123',
        worktreePath: '/tmp/worktrees/run-1',
        pauseFlagPath: '/tmp/worktrees/run-1/.slaveofai-pause',
        lastToolUseId: 'toolu_01ABC',
        lastToolName: 'Edit',
        numTurns: 7,
        deniedToolUseIds: ['toolu_01DEF', 'toolu_01GHI'],
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        dirtyFiles: ['src/index.ts', 'src/util.ts'],
        cumulativeCostUsd: 1.2345,
        cumulativeTokens: 45210,
        // Fix round 1: the four spawn-critical fields resume() cannot rediscover on its own once
        // the process that called start() is gone (see the m3 fix-round-1 brief and
        // packages/providers' checkpoint.ts docstring for the ruling). Required, NOT NULL, no
        // Prisma-level @default -- the orchestrator always writes them.
        settingsPath: '/tmp/worktrees/run-1/.claude/settings.json',
        hookPath: '/tmp/worktrees/run-1/.claude/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@example.com',
        // Deliberately not a PauseReason enum member's spelling — this field is free text (the
        // operator-supplied reason that went into the hook's deny message), not the category enum
        // that SlaveRun.pauseReason is. Using an enum-shaped value here would be the worst possible
        // example for the next implementer to copy.
        pauseReason: 'operator asked to rename the class to MathKit before continuing',
        requestedBy: 'erenaltan@gmail.com',
        ts,
      },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })

    expect(found.id).toBe(created.id)
    expect(found.runId).toBe(runId)
    expect(found.sessionId).toBe('session-123')
    expect(found.worktreePath).toBe('/tmp/worktrees/run-1')
    expect(found.pauseFlagPath).toBe('/tmp/worktrees/run-1/.slaveofai-pause')
    expect(found.lastToolUseId).toBe('toolu_01ABC')
    expect(found.lastToolName).toBe('Edit')
    expect(found.numTurns).toBe(7)
    expect(found.deniedToolUseIds).toEqual(['toolu_01DEF', 'toolu_01GHI'])
    expect(found.headCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(found.dirtyFiles).toEqual(['src/index.ts', 'src/util.ts'])
    expect(found.cumulativeCostUsd).toBe(1.2345)
    expect(found.cumulativeTokens).toBe(45210)
    expect(found.settingsPath).toBe('/tmp/worktrees/run-1/.claude/settings.json')
    expect(found.hookPath).toBe('/tmp/worktrees/run-1/.claude/pause-gate.sh')
    expect(found.gitAuthorName).toBe('Alex')
    expect(found.gitAuthorEmail).toBe('alex@example.com')
    expect(found.pauseReason).toBe('operator asked to rename the class to MathKit before continuing')
    expect(found.requestedBy).toBe('erenaltan@gmail.com')
    expect(found.ts).toEqual(ts)
  })

  it('allows the nullable fields to stay null for a checkpoint with no denials yet', async (): Promise<void> => {
    const runId = await seedRun()

    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-456',
        worktreePath: '/tmp/worktrees/run-2',
        pauseFlagPath: '/tmp/worktrees/run-2/.slaveofai-pause',
        deniedToolUseIds: [],
        headCommit: 'deadbeef',
        dirtyFiles: [],
        settingsPath: '/tmp/worktrees/run-2/.claude/settings.json',
        hookPath: '/tmp/worktrees/run-2/.claude/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@example.com',
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
    const runId = await seedRun()
    await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: 'session-789',
        worktreePath: '/tmp/worktrees/run-3',
        pauseFlagPath: '/tmp/worktrees/run-3/.slaveofai-pause',
        deniedToolUseIds: [],
        headCommit: 'cafef00d',
        dirtyFiles: [],
        settingsPath: '/tmp/worktrees/run-3/.claude/settings.json',
        hookPath: '/tmp/worktrees/run-3/.claude/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@example.com',
      },
    })

    await prisma.slaveRun.delete({ where: { id: runId } })

    expect(await prisma.checkpoint.count()).toBe(0)
  })
})

describe('Workspace command lists and halt state', () => {
  // No file-scoped beforeEach re-declared here: the top-level beforeEach already truncates
  // "Workspace" with CASCADE, which is sufficient for this describe block too.

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

  it('rejects a workspace created without verifyCommands or setupCommands', async (): Promise<void> => {
    // Prisma types scalar-list fields as optional in the create input regardless of @default, so
    // this line typechecks even though both columns are NOT NULL at the database level — the
    // schema.prisma departure comment is only real if something asserts the runtime rejection it
    // promises.
    await expect(prisma.workspace.create({ data: { name: 'w', repoPath: '/tmp/repo' } })).rejects.toThrow()
  })
})
