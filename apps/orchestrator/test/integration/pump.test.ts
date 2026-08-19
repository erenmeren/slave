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

  it('reports a run in progress as working, not still starting', async (): Promise<void> => {
    let release = (): void => {}
    const held = new Promise<void>((res) => {
      release = res
    })

    async function* stalls(): AsyncIterable<RuntimeEvent> {
      yield { kind: 'session_started', sessionId: 's-1' }
      await held
      yield { kind: 'terminated', outcome: okOutcome }
    }

    const pumping = pumpRun({ ...ids, events: stalls() })

    // `working` is only observable while the run is running -- every finished stream overwrites it
    // -- so this is the one shape that can pin it. A row stuck at `starting` misreports to §11's
    // `status` for the entire life of a run that is very much working.
    await new Promise((res) => setTimeout(res, 50))
    const midRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(midRun.status).toBe('working')

    release()
    await pumping
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

    // The run row itself is concluded. Left `working` it counts as non-terminal in `loadWorld`,
    // so the agent holding it stays busy forever and never enters the failure streak.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(run.terminalAt).not.toBeNull()

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

  it('still halts and still says so when the cancel itself fails', async (): Promise<void> => {
    const cancel = vi.fn(async (): Promise<void> => {
      throw new Error('SIGTERM failed: process not registered')
    })

    await pumpRun({
      ...ids,
      cancel,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'hook_crashed', hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'boom' },
      ]),
    })

    // The worst state the system can reach: an agent running with no gate, a kill that did not
    // land, and -- if the cancel's rejection escaped -- no halt, so the scheduler keeps starting
    // more of them. A failed cancel is the case where the halt matters MOST, and it must not be
    // the one case where the halt does not happen (spec §13's opening rule).
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
    expect(workspace.haltedReason).not.toBeNull()

    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.failed')
    expect(types).toContain('guardrail.tripped')

    const failedEvent = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_failed' },
    })
    // Louder, not quieter: the operator has to know the process may still be alive.
    expect((failedEvent.payload as { reason: string }).reason).toMatch(/cancel failed/i)
  })

  it('cancels before it writes anything about the failure', async (): Promise<void> => {
    let releaseCancel = (): void => {}
    const cancelled = new Promise<void>((res) => {
      releaseCancel = res
    })

    const pumping = pumpRun({
      ...ids,
      cancel: async (): Promise<void> => cancelled,
      events: fromArray([
        { kind: 'hook_crashed', hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'boom' },
      ]),
    })

    // Spec §13.1 behaviour 1 is first for a reason: an agent that cannot be paused must not be
    // left running while the orchestrator writes paperwork. `expect(cancel).toHaveBeenCalled()`
    // cannot tell an awaited cancel from a fired-and-forgotten one -- this can.
    await new Promise((res) => setTimeout(res, 50))
    expect(await prisma.executionEvent.count({ where: { runId: ids.runId } })).toBe(0)

    releaseCancel()
    await pumping
    expect(await eventTypesFor(ids.runId)).toContain('run.failed')
  })

  it('keeps recording what the ungated agent did after the gate failed', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: 'gone' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Write' },
        { kind: 'text', text: 'and then I did this' },
      ]),
    })

    // The fail-open reason promises to name the window between the gate breaking and the cancel
    // landing. Stopping the loop at the gate failure means refusing to read what happened inside
    // it -- and for this shape those events are the only record of side effects nobody could stop.
    const types = await eventTypesFor(ids.runId)
    expect(types.filter((t) => t === 'run.tool_call')).toHaveLength(2)
    expect(types).toContain('run.output')

    // Reacted exactly once, all the same: two attempts would double-count against the cap.
    expect(types.filter((t) => t === 'run.failed')).toHaveLength(1)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.attempt).toBe(1)
  })

  it('records a hook deny as a pause, so the killed process is not read as an orphan', async (): Promise<void> => {
    const outcome = await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash' },
        { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
      ]),
    })

    // Task 8's adapter kills the child on the first deny -- that is what pausing *is* -- so a run
    // left recorded as `working` presents to Task 15's orphan sweep as exactly the shape it fails:
    // non-terminal, dead pid. The sweep excludes `paused`, which only works if something writes it.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    expect(run.pausedAtStep).toBe(1)
    expect(await eventTypesFor(ids.runId)).toContain('run.paused')

    // A pause is not an outcome, and the adapter's synthetic terminal result on a deny reports
    // `isError: false` -- which must never be laundered into `run.succeeded`.
    expect(outcome).toBeNull()
    expect(await eventTypesFor(ids.runId)).not.toContain('run.succeeded')
  })

  it('writes a checkpoint a fresh process could resume from', async (): Promise<void> => {
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { worktreePath: '/tmp' } })

    await pumpRun({
      ...ids,
      spawn: {
        settingsPath: '/tmp/settings.json',
        pauseFlagPath: '/tmp/pause.flag',
        hookPath: '/tmp/pause-gate.sh',
        gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
      },
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash' },
        { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
      ]),
    })

    // The adapter's `resume()` takes a checkpoint precisely because a process that never called
    // `start()` cannot rediscover any of this: identity is supplied per-process by design, and the
    // settings file and hook path exist nowhere else. Until this row is written, a paused run
    // cannot be continued by anything -- which is the state the milestone was in.
    // Every field, because every one of them is something `resume()` spawns with -- a checkpoint
    // that resumes in the wrong directory under the wrong identity would pass a test that only
    // checked the row exists.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
    expect(checkpoint.sessionId).toBe('s-1')
    expect(checkpoint.worktreePath).toBe('/tmp')
    expect(checkpoint.pauseFlagPath).toBe('/tmp/pause.flag')
    expect(checkpoint.settingsPath).toBe('/tmp/settings.json')
    expect(checkpoint.hookPath).toBe('/tmp/pause-gate.sh')
    expect(checkpoint.gitAuthorName).toBe('Alex')
    expect(checkpoint.gitAuthorEmail).toBe('alex@aiteamos.local')
    expect(checkpoint.lastToolUseId).toBe('tu_1')
    expect(checkpoint.lastToolName).toBe('Bash')
    expect(checkpoint.numTurns).toBe(1)
    expect(checkpoint.pauseReason).toBe('operator asked to pause')
  })

  it('records the tool calls that were denied before the pause', async (): Promise<void> => {
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { worktreePath: '/tmp' } })

    await pumpRun({
      ...ids,
      spawn: {
        settingsPath: '/tmp/settings.json',
        pauseFlagPath: '/tmp/pause.flag',
        hookPath: '/tmp/pause-gate.sh',
        gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
      },
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'permission_denied', toolName: 'Edit', toolUseId: 'tu_denied' },
        { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'pause' },
      ]),
    })

    // ADR 0001 §5: on resume the model re-attempted exactly these calls, in order. It is the
    // operator's view of what the agent was about to do.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
    expect(checkpoint.deniedToolUseIds).toEqual(['tu_denied'])
  })

  it('does not overwrite a run an operator already stopped', async (): Promise<void> => {
    await prisma.agentRun.update({
      where: { id: ids.runId },
      data: { status: 'stopped', terminalAt: new Date(), endedAt: new Date() },
    })

    await pumpRun({ ...ids, events: fromArray([{ kind: 'session_started', sessionId: 's-1' }]) })

    // An operator's `cancel` writes `stopped` and kills the child; the stream then ends without a
    // terminal event, and the pump used to overwrite that with `failed` and announce it -- which
    // under a daemon is what happens on every single cancel.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('stopped')
    expect(await eventTypesFor(ids.runId)).not.toContain('run.failed')
  })

  it('does not write half a checkpoint for a run nothing could resume', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([{ kind: 'hook_denied', hookName: 'PreToolUse', reason: 'pause' }]),
    })

    // No session id means there is nothing to `--resume`, and no spawn facts means the caller could
    // not support a resume anyway. Half a checkpoint is worse than none: `resume()` would then fail
    // at the spawn rather than here, with the run already moved.
    expect(await prisma.checkpoint.count()).toBe(0)
  })

  it('fails a run whose stream ends without a terminal result', async (): Promise<void> => {
    const outcome = await pumpRun({
      ...ids,
      events: fromArray([{ kind: 'session_started', sessionId: 's-1' }]),
    })

    // The child died without reporting. Not a success, and not silent -- and the row must not be
    // left non-terminal, or the agent holding it never becomes schedulable again.
    expect(outcome).toBeNull()
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(run.terminalAt).not.toBeNull()
    expect(await eventTypesFor(ids.runId)).toContain('run.failed')
  })

  it('keeps reading after the terminal result, because the stream does not end there', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'terminated', outcome: okOutcome },
        // Spec §5.3 property 5: a hook_response can arrive *after* the terminal result. And every
        // real capture's last line is the routine Stop hook, which the parser classifies
        // `ignored` -- so a pump that returns at `terminated` stops reading one line early, every
        // single run, and would miss this gate failure entirely.
        { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: 'gone' },
        { kind: 'ignored', line: '{"type":"hook_response","hook_event":"Stop"}' },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    const types = await eventTypesFor(ids.runId)
    expect(types).not.toContain('run.succeeded')
    // An `ignored` line is recognized and not acted on: it must not produce an event of its own.
    expect(types.filter((t) => t === 'run.output')).toHaveLength(0)
  })

  it('truncates run.output from the end, keeping the beginning the reader wants', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'text', text: `HEAD${'x'.repeat(OUTPUT_CAP * 2)}TAIL` },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const output = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_output' },
    })
    const { text } = output.payload as { text: string }

    // A string of nothing but `x` cannot tell "keep the head" from "keep the tail", nor pin the
    // boundary -- both `slice(-CAP)` and `slice(0, CAP - 1000)` satisfy it.
    expect(text.startsWith('HEAD')).toBe(true)
    expect(text).not.toContain('TAIL')
    expect(text.length).toBe(OUTPUT_CAP)
    // And the reader is told the sentence was cut rather than left to think it just stopped.
    expect(text.endsWith('…')).toBe(true)
  })

  it('leaves output that exactly fits the cap alone', async (): Promise<void> => {
    const exact = 'y'.repeat(OUTPUT_CAP)

    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'text', text: exact },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const output = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_output' },
    })
    // Off-by-one at the boundary would add an ellipsis to text that was never truncated.
    expect((output.payload as { text: string }).text).toBe(exact)
  })

  it('counts tool calls across a resume instead of refunding the budget', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Edit' },
        { kind: 'tool_call', toolUseId: 'tu_3', toolName: 'Bash' },
        { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'pause' },
      ]),
    })

    // The adapter closes the old queue and `events()` hands out a new one, so a resumed run is a
    // second `pumpRun` on the same row (Task 6/9). A pump that writes an absolute local count
    // resets `AgentRun.toolCalls` to 1 here -- and that column is what Task 15's §3.3 ceiling
    // reads, so any agent that pauses once gets its budget silently refunded.
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-2' },
        { kind: 'tool_call', toolUseId: 'tu_4', toolName: 'Bash' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.toolCalls).toBe(4)
  })

  it('says out loud that it dropped an unparsable line', async (): Promise<void> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {})

    try {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'unparsable', line: '{bad' },
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      // Spec §13's rule is that no failure is silent. This one is deliberately recorded out of
      // band rather than as a domain event (§9 invents no catalogue names), and "out of band"
      // discharges the rule only if the record actually happens.
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls.flat().join(' ')).toContain('{bad')
    } finally {
      warn.mockRestore()
    }
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
