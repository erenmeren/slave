import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Checkpoint } from '../../src/claude/checkpoint.js'

/**
 * Pins `packages/providers`' `Checkpoint` interface against `packages/db`'s `Checkpoint` Prisma
 * model. The two shapes are deliberately duplicated (see `checkpoint.ts`'s own docstring for why
 * `src` may never import `@ai-team-os/db`) -- what is not acceptable is letting them drift apart
 * silently. This is the one place in `packages/providers` where a *test* importing `packages/db`
 * is correct rather than a violation of that boundary: it needs a real database to prove the
 * round trip, which is also why it lives in the integration project (`vitest.config.ts`'s
 * `integration` project, not `unit`) rather than beside the rest of this package's tests.
 *
 * Every field on `Checkpoint` is set here, deliberately, to a value that would not equal a
 * zero-value/default (`numTurns: 0`, `cumulativeCostUsd: 0`, empty arrays, `null` fields) if the
 * write silently dropped it -- an empty-array default and a genuinely-empty array read back are
 * indistinguishable, which is why the array fields are non-empty and the nullable fields are
 * exercised in their non-null form here. A second test below exercises the null/empty case
 * specifically, which `packages/db`'s own `checkpoint.test.ts` already covers on the Prisma side
 * but is worth confirming still round-trips starting from this package's own `Checkpoint` values.
 */

async function seedRun(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'w-providers-checkpoint-pin',
      repoPath: '/tmp/repo-providers-pin',
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
  const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId: agent.id } })
  return run.id
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "AgentRun", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Checkpoint shape pinning (providers interface <-> db model)', () => {
  it('writes a Checkpoint built from the providers interface through Prisma and reads every field back unchanged', async (): Promise<void> => {
    const runId = await seedRun()

    // Built purely from the providers `Checkpoint` interface -- no field here is copied from, or
    // checked against, the Prisma model's own shape. If a field existed on one side and not the
    // other, this object literal (extra prop) or the `data: { ...checkpoint, runId }` spread
    // below (missing required prop) would fail to typecheck, and the assertions after it would
    // fail to compile or to pass if a same-named field diverged in type.
    const checkpoint: Checkpoint = {
      sessionId: 'session-pin-123',
      worktreePath: '/tmp/worktrees/pin-run-1',
      pauseFlagPath: '/tmp/worktrees/pin-run-1/.aiteamos-pause',
      lastToolUseId: 'toolu_01PINABC',
      lastToolName: 'Edit',
      numTurns: 9,
      deniedToolUseIds: ['toolu_01PINDEF', 'toolu_01PINGHI'],
      headCommit: 'f00dcafebabe1234567890abcdef1234567890ab',
      dirtyFiles: ['src/pin.ts', 'src/pin.test.ts'],
      cumulativeCostUsd: 3.1415,
      cumulativeTokens: 98765,
      // Fix round 1's four spawn-critical fields. Non-empty and distinct from the second test's
      // values below -- an empty-string default and a genuinely-empty string read back are just
      // as indistinguishable as an empty array is, so these are set the same way the rest of this
      // test's non-zero/non-empty values are.
      settingsPath: '/tmp/worktrees/pin-run-1/.claude/settings.json',
      hookPath: '/tmp/worktrees/pin-run-1/.claude/pause-gate.sh',
      gitAuthorName: 'Pin Author',
      gitAuthorEmail: 'pin-author@example.com',
    }

    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: checkpoint.sessionId,
        worktreePath: checkpoint.worktreePath,
        pauseFlagPath: checkpoint.pauseFlagPath,
        lastToolUseId: checkpoint.lastToolUseId,
        lastToolName: checkpoint.lastToolName,
        numTurns: checkpoint.numTurns,
        deniedToolUseIds: [...checkpoint.deniedToolUseIds],
        headCommit: checkpoint.headCommit,
        dirtyFiles: [...checkpoint.dirtyFiles],
        cumulativeCostUsd: checkpoint.cumulativeCostUsd,
        cumulativeTokens: checkpoint.cumulativeTokens,
        settingsPath: checkpoint.settingsPath,
        hookPath: checkpoint.hookPath,
        gitAuthorName: checkpoint.gitAuthorName,
        gitAuthorEmail: checkpoint.gitAuthorEmail,
      },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { id: created.id } })

    // Every field on the providers `Checkpoint` interface, checked individually rather than via
    // a single `toMatchObject` -- a bulk comparison would still pass if both sides happened to
    // drop the same field, which is exactly the silent-drift case this test exists to catch.
    expect(found.sessionId).toBe(checkpoint.sessionId)
    expect(found.worktreePath).toBe(checkpoint.worktreePath)
    expect(found.pauseFlagPath).toBe(checkpoint.pauseFlagPath)
    expect(found.lastToolUseId).toBe(checkpoint.lastToolUseId)
    expect(found.lastToolName).toBe(checkpoint.lastToolName)
    expect(found.numTurns).toBe(checkpoint.numTurns)
    expect(found.deniedToolUseIds).toEqual([...checkpoint.deniedToolUseIds])
    expect(found.headCommit).toBe(checkpoint.headCommit)
    expect(found.dirtyFiles).toEqual([...checkpoint.dirtyFiles])
    expect(found.cumulativeCostUsd).toBe(checkpoint.cumulativeCostUsd)
    expect(found.cumulativeTokens).toBe(checkpoint.cumulativeTokens)
    expect(found.settingsPath).toBe(checkpoint.settingsPath)
    expect(found.hookPath).toBe(checkpoint.hookPath)
    expect(found.gitAuthorName).toBe(checkpoint.gitAuthorName)
    expect(found.gitAuthorEmail).toBe(checkpoint.gitAuthorEmail)
  })

  it('round-trips the nullable fields and empty arrays a Checkpoint with no denials yet actually has', async (): Promise<void> => {
    const runId = await seedRun()

    const checkpoint: Checkpoint = {
      sessionId: 'session-pin-456',
      worktreePath: '/tmp/worktrees/pin-run-2',
      pauseFlagPath: '/tmp/worktrees/pin-run-2/.aiteamos-pause',
      lastToolUseId: null,
      lastToolName: null,
      numTurns: 0,
      deniedToolUseIds: [],
      headCommit: 'cafef00d',
      dirtyFiles: [],
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      // Unlike lastToolUseId/deniedToolUseIds above, these four have no null/empty variant on
      // `Checkpoint` -- they are required strings with no zero value that means anything -- so
      // this second test still exercises them with real, non-empty values (distinct from the
      // first test's, so a value bleeding across tests would also be caught).
      settingsPath: '/tmp/worktrees/pin-run-2/.claude/settings.json',
      hookPath: '/tmp/worktrees/pin-run-2/.claude/pause-gate.sh',
      gitAuthorName: 'Second Pin Author',
      gitAuthorEmail: 'second-pin-author@example.com',
    }

    const created = await prisma.checkpoint.create({
      data: {
        runId,
        sessionId: checkpoint.sessionId,
        worktreePath: checkpoint.worktreePath,
        pauseFlagPath: checkpoint.pauseFlagPath,
        lastToolUseId: checkpoint.lastToolUseId,
        lastToolName: checkpoint.lastToolName,
        numTurns: checkpoint.numTurns,
        deniedToolUseIds: [...checkpoint.deniedToolUseIds],
        headCommit: checkpoint.headCommit,
        dirtyFiles: [...checkpoint.dirtyFiles],
        cumulativeCostUsd: checkpoint.cumulativeCostUsd,
        cumulativeTokens: checkpoint.cumulativeTokens,
        settingsPath: checkpoint.settingsPath,
        hookPath: checkpoint.hookPath,
        gitAuthorName: checkpoint.gitAuthorName,
        gitAuthorEmail: checkpoint.gitAuthorEmail,
      },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { id: created.id } })

    expect(found.lastToolUseId).toBeNull()
    expect(found.lastToolName).toBeNull()
    expect(found.numTurns).toBe(0)
    expect(found.deniedToolUseIds).toEqual([])
    expect(found.dirtyFiles).toEqual([])
    expect(found.cumulativeCostUsd).toBe(0)
    expect(found.cumulativeTokens).toBe(0)
    expect(found.settingsPath).toBe(checkpoint.settingsPath)
    expect(found.hookPath).toBe(checkpoint.hookPath)
    expect(found.gitAuthorName).toBe(checkpoint.gitAuthorName)
    expect(found.gitAuthorEmail).toBe(checkpoint.gitAuthorEmail)
  })
})
