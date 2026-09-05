import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { claimResume, requestResume, updateQueuedMessage } from '../../src/resume.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

/**
 * A run seeded exactly as a real pause leaves one: `paused`, with the full `Checkpoint` row the
 * pump writes at the moment it pauses. Nothing here may seed `resuming` — that is the shape the
 * orphan sweep destroys, and these tests exist to prove the intent never produces it.
 */
async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-resume-'))
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add checkout retry',
      description: 'Retry failed payments',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'paused', pauseReason: 'human' },
  })
  await prisma.checkpoint.create({
    data: {
      runId: run.id,
      sessionId: 'session-123',
      worktreePath: join(repoPath, '.slaveofai', 'worktrees', 'T-abcdef12'),
      pauseFlagPath: join(repoPath, '.slaveofai', 'runs', run.id, 'pause.flag'),
      settingsPath: join(repoPath, '.slaveofai', 'runs', run.id, 'settings.json'),
      hookPath: join(repoPath, 'scripts', 'pause-gate.sh'),
      gitAuthorName: 'Alex',
      gitAuthorEmail: 'alex@slaveofai.local',
      lastToolUseId: 'toolu_01ABC',
      lastToolName: 'Edit',
      numTurns: 3,
      deniedToolUseIds: ['toolu_01ABC'],
      headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      dirtyFiles: ['src/index.ts'],
      cumulativeCostUsd: 0.42,
      cumulativeTokens: 1234,
    },
  })
  return { workspace: { id: workspace.id, repoPath }, task: { id: task.id }, run: { id: run.id } }
}

describe('the resume intent', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('records the intent and the event; the run stays paused', async (): Promise<void> => {
    const { run } = fixture
    const result = await requestResume(run.id, 'also create EXTRA.md', 'meren')
    expect(result.ok).toBe(true)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('paused') // NEVER resuming from here (sweep safety)
    expect(after.resumeRequestedAt).not.toBeNull()
    expect(after.queuedMessage).toBe('also create EXTRA.md')

    const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_resume_requested' } })
    expect(event?.payload).toEqual({ requestedBy: 'meren', message: 'also create EXTRA.md' })
    expect(event?.actor).toBe('human')
  })

  it('keeps an already-queued message when resume is requested without one', async (): Promise<void> => {
    const { run } = fixture
    await updateQueuedMessage(run.id, 'first instruction')
    await requestResume(run.id, null, 'meren')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.queuedMessage).toBe('first instruction')
  })

  it('refuses when the workspace is halted', async (): Promise<void> => {
    const { run, workspace } = fixture
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { haltedReason: 'gate failure', haltedAt: new Date() },
    })

    const result = await requestResume(run.id, null, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('workspace_halted')
    // The refusal is total: nothing is recorded for a daemon to pick up the moment the halt clears.
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.resumeRequestedAt).toBeNull()
  })

  it('refuses a run that is not paused / has no checkpoint', async (): Promise<void> => {
    const { run } = fixture
    await prisma.checkpoint.delete({ where: { runId: run.id } })
    expect((await requestResume(run.id, null, 'meren')).ok).toBe(false)

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'working' } })
    const result = await requestResume(run.id, null, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('wrong_status')
  })

  it('names the missing checkpoint rather than the status when the run is paused', async (): Promise<void> => {
    const { run } = fixture
    await prisma.checkpoint.delete({ where: { runId: run.id } })

    const result = await requestResume(run.id, null, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no_checkpoint')
  })

  it('refuses an unknown run id', async (): Promise<void> => {
    const result = await requestResume('00000000-0000-4000-8000-000000000000', null, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })

  it('claimResume flips paused→resuming and hands back the message exactly once', async (): Promise<void> => {
    const { run } = fixture
    await requestResume(run.id, 'do the thing', 'meren')

    const first = await claimResume(run.id)
    expect(first).toEqual({ claimed: true, queuedMessage: 'do the thing' })

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('resuming')
    expect(after.resumeRequestedAt).toBeNull()
    expect(after.queuedMessage).toBeNull()

    expect((await claimResume(run.id)).claimed).toBe(false)
  })

  it('claimResume refuses a paused run with no intent recorded', async (): Promise<void> => {
    const { run } = fixture

    // The intent column, not the status, is what the daemon's pass claims on: a paused run nobody
    // asked to resume must survive every tick untouched.
    expect(await claimResume(run.id)).toEqual({ claimed: false, queuedMessage: null })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('paused')
  })

  it('updateQueuedMessage overwrites the single slot rather than accumulating', async (): Promise<void> => {
    const { run } = fixture
    await updateQueuedMessage(run.id, 'first instruction')
    const second = await updateQueuedMessage(run.id, 'second instruction')

    expect(second.ok).toBe(true)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toBe(
      'second instruction',
    )
  })

  it('updateQueuedMessage refuses when the run is not paused', async (): Promise<void> => {
    const { run } = fixture
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'working' } })

    const result = await updateQueuedMessage(run.id, 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('wrong_status')
  })

  it('updateQueuedMessage refuses an unknown run id', async (): Promise<void> => {
    const result = await updateQueuedMessage('00000000-0000-4000-8000-000000000000', 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })

  it('updateQueuedMessage normalizes an empty or whitespace-only save to clearing the slot', async (): Promise<void> => {
    const { run } = fixture
    await updateQueuedMessage(run.id, 'first instruction')

    const cleared = await updateQueuedMessage(run.id, '')
    expect(cleared.ok).toBe(true)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toBeNull()

    await updateQueuedMessage(run.id, 'second instruction')
    const clearedByWhitespace = await updateQueuedMessage(run.id, '   \n\t ')
    expect(clearedByWhitespace.ok).toBe(true)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toBeNull()
  })

  it('requestResume normalizes an empty message to null rather than queuing an empty prompt', async (): Promise<void> => {
    const { run } = fixture
    const result = await requestResume(run.id, '', 'meren')
    expect(result.ok).toBe(true)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.resumeRequestedAt).not.toBeNull()
    expect(after.queuedMessage).toBeNull()

    const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_resume_requested' } })
    expect(event?.payload).toEqual({ requestedBy: 'meren', message: null })
  })

  describe('requestResume liveness', () => {
    async function pausedRunWithCheckpoint(pid: number | null): Promise<string> {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused', pid } })
      // `seed()` already writes a Checkpoint for this run (`runId` is `@unique`); replace it rather
      // than colliding on the constraint. The brief's literal `create` assumed no checkpoint existed
      // yet -- it does, so this deviates from the brief verbatim in this one line only.
      await prisma.checkpoint.delete({ where: { runId: fixture.run.id } })
      await prisma.checkpoint.create({
        data: {
          runId: fixture.run.id,
          sessionId: 's-1',
          worktreePath: '/tmp',
          pauseFlagPath: '/tmp/pause.flag',
          settingsPath: '/tmp/settings.json',
          hookPath: '/tmp/pause-gate.sh',
          gitAuthorName: 'Alex',
          gitAuthorEmail: 'alex@slaveofai.local',
          headCommit: 'abc123',
        },
      })
      return fixture.run.id
    }

    /** A real, live pid: `/bin/sleep` for long enough that no test outlives it. */
    function liveSleeper(): { pid: number; stop: () => void } {
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      if (child.pid === undefined) throw new Error('liveSleeper: no pid')
      return {
        pid: child.pid,
        stop: () => {
          try {
            process.kill(child.pid as number, 'SIGKILL')
          } catch {
            // Already gone.
          }
        },
      }
    }

    /** A real pid that is definitely gone: spawn `/bin/true` and wait for its exit. */
    async function deadPid(): Promise<number> {
      const child = spawn('/bin/true', [], { stdio: 'ignore' })
      if (child.pid === undefined) throw new Error('deadPid: no pid')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      return child.pid
    }

    it('refuses a paused run whose process is still alive, with the verbatim text', async (): Promise<void> => {
      const sleeper = liveSleeper()
      try {
        const runId = await pausedRunWithCheckpoint(sleeper.pid)
        const result = await requestResume(runId, null, 'meren')

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.kind).toBe('run_still_stopping')
        expect(refusalText(result.error)).toBe('the run is still stopping; retry in a moment')

        // Nothing was recorded: a refused resume must not arm one.
        const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
        expect(after.resumeRequestedAt).toBeNull()
        expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resume_requested' } })).toBe(0)
      } finally {
        sleeper.stop()
      }
    })

    it('proceeds for a paused run whose pid is really gone', async (): Promise<void> => {
      const runId = await pausedRunWithCheckpoint(await deadPid())
      const result = await requestResume(runId, null, 'meren')

      expect(result.ok).toBe(true)
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      expect(after.resumeRequestedAt).not.toBeNull()
    })

    it('proceeds for a row that never recorded a pid at all', async (): Promise<void> => {
      // Pre-M12 rows, and rows the pump already cleared. A null pid is not a refusal (spec §3.2).
      const runId = await pausedRunWithCheckpoint(null)
      expect((await requestResume(runId, null, 'meren')).ok).toBe(true)
    })
  })
})
