import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { agentId, runId, taskId, workspaceId } from '@ai-team-os/domain'
import type { RunOutcome, RuntimeEvent } from '@ai-team-os/providers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTPUT_CAP, pumpRun } from '../../src/pump.js'

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

/** The adapter hands the pump an async stream; an array is the same contract without a process. */
async function* fromArray(events: readonly RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const event of events) {
    yield event
    // Yield to the event loop between events, so a pump that reacts mid-stream (a gate failure
    // must not wait for the end) is genuinely reacting mid-stream rather than after the array
    // has already been fully consumed by a synchronous generator.
    await Promise.resolve()
  }
}

const okOutcome: RunOutcome = {
  isError: false,
  terminalReason: 'completed',
  stopReason: null,
  numTurns: 3,
  costUsd: 0.05,
  deniedToolUseIds: [],
}

interface Ids {
  readonly runId: ReturnType<typeof runId>
  readonly taskId: ReturnType<typeof taskId>
  readonly agentId: ReturnType<typeof agentId>
  readonly workspaceId: ReturnType<typeof workspaceId>
  readonly cancel: () => Promise<void>
}

/**
 * `cancel` is part of the fixture rather than optional in the signature. The plan's sample tests
 * spread `...ids` without one while its Interfaces block declares it required; resolving that by
 * making the parameter optional would make a pump that can silently fail to stop an ungated agent
 * a type-legal construction.
 */
async function seed(): Promise<Ids> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend' },
  })
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
    data: { taskId: task.id, agentId: agent.id, status: 'starting' },
  })

  return {
    runId: runId(run.id),
    taskId: taskId(task.id),
    agentId: agentId(agent.id),
    workspaceId: workspaceId(workspace.id),
    cancel: async (): Promise<void> => {},
  }
}

/** A second run on the same workspace, for the two-gate-failures case. */
async function seedSecondRun(ids: Ids): Promise<Ids> {
  const agent = await prisma.agent.create({
    data: {
      teamId: (await prisma.team.findFirstOrThrow()).id,
      name: 'Blair',
      role: 'backend',
    },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: ids.workspaceId,
      title: 'the second task',
      description: 'hosts the second run',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'starting' },
  })
  return { ...ids, runId: runId(run.id), taskId: taskId(task.id), agentId: agentId(agent.id) }
}

async function eventTypesFor(forRunId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { runId: forRunId },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

describe('pumpRun', () => {
  let ids: Ids

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    ids = await seed()
  })

  it('emits run.started only when the session id arrives, not at spawn', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    // Spec §5.4: `run.started`'s payload carries the session id, and no session id exists before
    // the child's first `system/init` line. Emitting it at spawn would mean inventing one.
    const types = await eventTypesFor(ids.runId)
    expect(types[0]).toBe('run.started')
  })

  it('writes the session id onto the run in the same step as run.started', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    // Spec §5.4 in as many words: "`AgentRun.sessionId` is written in the same step". Nothing else
    // in the plan writes it, and §5.7's resume reads it.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.sessionId).toBe('s-1')
  })

  it('maps a permission-mode denial to guardrail.tripped, never to run.paused', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'permission_denied', toolName: 'Edit', toolUseId: 'tu_1' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    // A permission-mode denial and a hook deny are different shapes with different meanings
    // (spec §5.3): only the second is a pause. Conflating them reports an agent that was refused
    // one tool as an agent that was deliberately paused.
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('guardrail.tripped')
    expect(types).not.toContain('run.paused')
  })

  it('records an unparsable line without killing the run', async (): Promise<void> => {
    const outcome = await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'unparsable', line: '{bad' },
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    // Spec §13: dropped and recorded, the run continues. Safe only because a dropped line is not
    // a gate signal -- a `hook_response` is never unparsable, which is Task 4's guard.
    expect(outcome).not.toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.started')
  })

  it('emits run.tool_call per tool use and counts it into the column the ceiling is read from', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Edit' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    // Spec §5.4: the count "is what `AgentRun.toolCalls` and the tool-call ceiling in §3.3 are
    // read from". Task 15's ceiling test seeds that column by hand, so nothing else in the
    // milestone would notice it never being written.
    const types = await eventTypesFor(ids.runId)
    expect(types.filter((t) => t === 'run.tool_call')).toHaveLength(2)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.toolCalls).toBe(2)
  })

  it('carries the agent text through to run.output, truncated rather than dropped', async (): Promise<void> => {
    const long = 'x'.repeat(OUTPUT_CAP + 100)

    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'text', text: long },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const output = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_output' },
    })
    const { text } = output.payload as { text: string }
    expect(text.length).toBeLessThanOrEqual(OUTPUT_CAP)
    expect(text.startsWith('x')).toBe(true)
  })

  it('concludes the run row itself: terminal status, cost, and terminalAt', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: { ...okOutcome, numTurns: 4, costUsd: 0.12 } },
      ]),
    })

    // The pump is the only component that sees the stream end, so nothing else can conclude the
    // row. `terminalAt` is the column `loadWorld` orders the failure streak by.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('succeeded')
    expect(run.costUsd).toBe(0.12)
    expect(run.terminalAt).not.toBeNull()
  })

  it('reports a clean-completion-with-denials run as failed', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: { ...okOutcome, deniedToolUseIds: ['tu_1'] } },
      ]),
    })

    // ADR 0001's finding: a run reported `is_error: false` while landing nothing, and the only
    // evidence was a non-empty `permission_denials`. Trusting the terminal flag alone records
    // that run as a success.
    expect(await eventTypesFor(ids.runId)).toContain('run.failed')
  })

  it('reacts to a blocking hook crash before any terminated event arrives: cancels, fails the run, halts the workspace', async (): Promise<void> => {
    const cancel = vi.fn(async (): Promise<void> => {})

    await pumpRun({
      ...ids,
      cancel,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'hook_crashed', hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'deliberate hook crash' },
      ]),
    })

    // Note what this event array does NOT contain: a `terminated`. A gate failure that waits for
    // the stream to end is a gate failure that never fires, because the run whose gate has failed
    // is precisely the run that may never stop on its own.
    expect(cancel).toHaveBeenCalled()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.failed')
    expect(types).toContain('guardrail.tripped')

    const failedEvent = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_failed' },
    })
    expect((failedEvent.payload as { reason: string }).reason).toMatch(/stopped/i)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.attempt).toBe(1)

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
    expect(workspace.haltedReason).not.toBeNull()
    expect(workspace.haltedAt).not.toBeNull()
  })

  it('reacts to a fail-open hook failure with a reason that must not read like the blocking crash above', async (): Promise<void> => {
    const cancel = vi.fn(async (): Promise<void> => {})

    await pumpRun({
      ...ids,
      cancel,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        {
          kind: 'hook_failed_open',
          hookName: 'PreToolUse:Write',
          exitCode: 127,
          stderr: '/bin/sh: line 1: /nope/hook.sh: No such file or directory',
        },
      ]),
    })

    expect(cancel).toHaveBeenCalled()

    // Spec §13.1: the blocking crash says the run was stopped; this one must say the run kept
    // going ungated for the whole window between the flag and the cancel landing. Same wording as
    // the test above is the conflation ADR 0001 and spec §13.1 warn against -- and it is the
    // dangerous direction, because it reports an uncontrolled run as a controlled one.
    const failedEvent = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_failed' },
    })
    expect((failedEvent.payload as { reason: string }).reason).toMatch(
      /ungated|no gate|kept (going|running|acting)/i,
    )

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
    expect(workspace.haltedReason).not.toBeNull()
  })

  it('halts once: a second gate failure does not overwrite the first reason', async (): Promise<void> => {
    const cancel = vi.fn(async (): Promise<void> => {})

    await pumpRun({
      ...ids,
      cancel,
      events: fromArray([
        { kind: 'hook_crashed', hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'first' },
      ]),
    })
    const first = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })

    const second = await seedSecondRun(ids)
    await pumpRun({
      ...second,
      cancel,
      events: fromArray([
        { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: 'second' },
      ]),
    })

    // The earliest gate failure is the one that explains the workspace's state, and `haltedAt` is
    // the moment of the transition. A blind overwrite would keep moving that timestamp forward
    // for as long as runs keep failing, so the halt would look newer than it is.
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
    expect(after.haltedReason).toBe(first.haltedReason)
    expect(after.haltedAt).toEqual(first.haltedAt)

    // Each run still gets its own account of what happened to it: a second broken run is news
    // about a second run, even in a workspace that is already halted.
    expect(await eventTypesFor(second.runId)).toContain('run.failed')
  })
})
