import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { agentId, runId, taskId, workspaceId } from '@ai-team-os/domain'
import type { RuntimeEvent } from '@ai-team-os/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pumpRun } from '../../src/pump.js'

/**
 * How a Cursor run actually pauses, end to end at the pump.
 *
 * Cursor has no mid-run gate (`canPauseMidRun: false`), so `signalPause('cursor', …)` kills the
 * process and the stream simply ENDS. Before this file, that ending was indistinguishable from a
 * crash: the pump concluded `failed`, wrote no checkpoint, and the operator's deliberate pause was
 * recorded as the run dying. `run.paused` never fired and nothing could resume it.
 *
 * Claude's path is untouched and one test here proves it: for `claude_code` the same stream ending
 * must still conclude `failed`, because Claude pauses through its gate (`hook_denied` ->
 * `stopped_by_gate`) long before the stream ends, and a stream that ends without one really is a
 * dead run.
 */
afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

async function* fromArray(events: readonly RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const event of events) {
    yield event
    await Promise.resolve()
  }
}

interface Ids {
  readonly runId: ReturnType<typeof runId>
  readonly taskId: ReturnType<typeof taskId>
  readonly agentId: ReturnType<typeof agentId>
  readonly workspaceId: ReturnType<typeof workspaceId>
  readonly cancel: () => Promise<void>
}

async function seed(status: string): Promise<Ids> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'the task under run',
      description: 'hosts the run being pumped',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.agentRun.create({
    // `pause_requested` is the state `requestPause` leaves behind: it claims the status, then
    // signals. For Cursor the signal is the kill, so by the time this pump reaches the end of the
    // stream the row already reads `pause_requested` -- that is the whole discriminator.
    data: { taskId: task.id, agentId: agent.id, status: status as 'pause_requested', toolCalls: 4 },
  })
  return {
    runId: runId(run.id),
    taskId: taskId(task.id),
    agentId: agentId(agent.id),
    workspaceId: workspaceId(workspace.id),
    cancel: async (): Promise<void> => {},
  }
}

async function eventTypesFor(forRunId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { runId: forRunId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

describe('pumpRun, when a paused Cursor run ends', () => {
  let dir: string
  let spawnFacts: NonNullable<Parameters<typeof pumpRun>[0]['spawn']>

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-pump-'))
    writeFileSync(path.join(dir, 'pause.flag'), 'meren\n')
    spawnFacts = {
      settingsPath: path.join(dir, '.cursor', 'hooks.json'),
      pauseFlagPath: path.join(dir, 'pause.flag'),
      hookPath: '/opt/aiteamos/cursor-shell-gate.sh',
      gitIdentity: { name: 'Alex', email: 'alex@example.com' },
      provider: 'cursor',
    }
  })

  afterEach((): void => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a pause, not a failure, when the stream ends with no terminal result', async (): Promise<void> => {
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([{ kind: 'session_started', sessionId: 's-cursor-1' }]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    // Non-terminal: a paused run has not ended, and writing `endedAt` here would put it beyond
    // every `endedAt: null` guard a later resume depends on.
    expect(run.endedAt).toBeNull()
    expect(run.pausedAtStep).toBe(4)
    expect(await eventTypesFor(ids.runId)).toContain('run.paused')
    expect(await eventTypesFor(ids.runId)).not.toContain('run.failed')
  })

  it('writes the checkpoint that makes the resume possible at all', async (): Promise<void> => {
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([{ kind: 'session_started', sessionId: 's-cursor-1' }]),
    })

    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
    // The two fields the plan names for this task specifically: without them `resume()` has no
    // session to continue and no way to know which adapter to continue it with.
    expect(checkpoint.sessionId).toBe('s-cursor-1')
    expect(checkpoint.provider).toBe('cursor')
    expect(checkpoint.requestedBy).toBe('meren')
  })

  it('records the pause when the run reported a terminal result on its way out, too', async (): Promise<void> => {
    // The kill can land after the CLI has already written its `result` line. The operator asked for
    // a pause either way, and a run that reports `is_error` because it was killed must not be
    // filed as a failure.
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-cursor-1' },
        {
          kind: 'terminated',
          outcome: {
            isError: true,
            terminalReason: 'stream ended',
            stopReason: null,
            numTurns: 2,
            costUsd: null,
            deniedToolUseIds: [],
          },
        },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    expect(await eventTypesFor(ids.runId)).not.toContain('run.failed')
  })

  it('lets a run that finished cleanly finish, even with a pause request in flight', async (): Promise<void> => {
    // THE `finished_first` CASE the brief's own pause strategy names. `signalPause('cursor')` kills
    // by pid, and a child that had already exited makes that a quiet no-op (ESRCH) -- so the row
    // reads `pause_requested` while the stream carries a perfectly clean `result` line. The run is
    // DONE. Recording it as `paused` would take a successful run non-terminal forever: the
    // scheduler would never advance its task, and an operator would be invited to resume a session
    // that has nothing left to do.
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-cursor-1' },
        {
          kind: 'terminated',
          outcome: {
            isError: false,
            terminalReason: 'success',
            stopReason: null,
            numTurns: 3,
            costUsd: null,
            deniedToolUseIds: [],
          },
        },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('succeeded')
    expect(run.terminalAt).not.toBeNull()
    expect(run.endedAt).not.toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.succeeded')
    expect(types).not.toContain('run.paused')
    // No resume point, because there is nothing to resume.
    expect(await prisma.checkpoint.findUnique({ where: { runId: ids.runId } })).toBeNull()
  })

  it('records the pause when the clean terminal line was reached only because the gate denied a call', async (): Promise<void> => {
    // THE CASE THE GATE EXISTS FOR (final review I2). `signalPause('cursor')` writes the flag and
    // then SIGTERMs with a 2 s grace; in that window the agent can still start one more shell
    // command, and `cursor-shell-gate.sh` -- armed by the flag this system just wrote -- denies it.
    // `cursor-agent` reads that denial as an ordinary tool error and can still reach its `result`
    // line with `is_error: false`. A denial on a Cursor run is only ever produced by THIS system's
    // own hook, and that hook only denies while the pause flag exists, so a non-empty
    // `deniedToolUseIds` means a pause was in flight: the clean terminal must not win the race.
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-cursor-1' },
        {
          kind: 'terminated',
          outcome: {
            isError: false,
            terminalReason: 'success',
            stopReason: null,
            numTurns: 3,
            costUsd: null,
            deniedToolUseIds: ['call-9'],
          },
        },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    expect(run.endedAt).toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.paused')
    expect(types).not.toContain('run.failed')
    // Without this the pause has nothing to continue from, which is what made the old behaviour
    // cost a run rather than merely mislabel one.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
    expect(checkpoint.sessionId).toBe('s-cursor-1')
    expect(checkpoint.provider).toBe('cursor')
    // `checkpoint.deniedToolUseIds` stays empty here on purpose, and it is not the same list: the
    // pump's own `denied` accumulator collects mid-stream `permission_denied`/`hook_denied` events,
    // which Cursor never emits (`gate: 'shell-only'`, and its denials arrive folded into the
    // terminal `result` line instead). The denial that reclassified this run rides in `outcome`.
    expect(checkpoint.deniedToolUseIds).toEqual([])
  })

  it('still fails a Cursor run whose calls were denied with no pause requested', async (): Promise<void> => {
    // The inverse guard. The denial widens WHICH outcomes reach the pause path, not WHETHER the
    // pause was requested: a `working` run keeps the existing "clean completion with denials is a
    // failure" conclusion (ADR 0001 measured a run reporting `is_error: false` while landing
    // nothing), and only the claimed `pause_requested` status can reclassify it.
    const ids = await seed('working')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-cursor-1' },
        {
          kind: 'terminated',
          outcome: {
            isError: false,
            terminalReason: 'success',
            stopReason: null,
            numTurns: 3,
            costUsd: null,
            deniedToolUseIds: ['call-9'],
          },
        },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(run.endedAt).not.toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.failed')
    expect(types).not.toContain('run.paused')
  })

  it('still fails a Cursor run that ended without anyone asking for a pause', async (): Promise<void> => {
    // The discriminator is the requested pause, not the provider. A Cursor run whose child simply
    // died is a failure and must stay one.
    const ids = await seed('working')

    await pumpRun({
      ...ids,
      spawn: spawnFacts,
      events: fromArray([{ kind: 'session_started', sessionId: 's-cursor-1' }]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(await eventTypesFor(ids.runId)).toContain('run.failed')
  })

  it('leaves a claude_code run in pause_requested on exactly the path it took before', async (): Promise<void> => {
    // SERIES A ZERO-DIFF. Claude pauses through its gate, which fires long before the stream ends;
    // a Claude stream that ends with no terminal event is a dead run, and turning that into a
    // `paused` row would silently reclassify every Claude crash that raced an operator's pause.
    const ids = await seed('pause_requested')

    await pumpRun({
      ...ids,
      spawn: { ...spawnFacts, provider: 'claude_code' },
      events: fromArray([{ kind: 'session_started', sessionId: 's-claude-1' }]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(await eventTypesFor(ids.runId)).toContain('run.failed')
    expect(await prisma.checkpoint.findUnique({ where: { runId: ids.runId } })).toBeNull()
  })
})
