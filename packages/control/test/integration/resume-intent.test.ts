import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
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
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-resume-'))
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
      worktreePath: join(repoPath, '.aiteamos', 'worktrees', 'T-abcdef12'),
      pauseFlagPath: join(repoPath, '.aiteamos', 'runs', run.id, 'pause.flag'),
      settingsPath: join(repoPath, '.aiteamos', 'runs', run.id, 'settings.json'),
      hookPath: join(repoPath, 'scripts', 'pause-gate.sh'),
      gitAuthorName: 'Alex',
      gitAuthorEmail: 'alex@aiteamos.local',
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
})
