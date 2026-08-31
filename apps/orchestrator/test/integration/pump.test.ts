import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAlive } from '@ai-team-os/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { agentId, runId, taskId, workspaceId } from '@ai-team-os/domain'
import { PERMISSION_DENY_REASON_PREFIX, parseStreamLine, type RunOutcome, type RuntimeEvent } from '@ai-team-os/providers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTPUT_CAP, pumpRun } from '../../src/pump.js'

/**
 * Reads one of `packages/providers/test/fixtures/*.ndjson` and runs every line through the real
 * Claude stream parser (`@ai-team-os/providers`'s `parseStreamLine`), the same function the real
 * adapter's `events()` uses. This is what makes the M18 Task 6 tests below a genuine end-to-end
 * proof of the fixture rather than a hand-authored stand-in for it: the matrix-prefixed reason
 * string actually round-trips through the real parser (and, for `hook_denied`, through
 * `classifyGateEvent` inside `pumpRun` itself) before `pumpRun` ever sees the resulting
 * `RuntimeEvent`s.
 */
function eventsFromFixture(name: string): readonly RuntimeEvent[] {
  const path = new URL(`../../../../packages/providers/test/fixtures/${name}.ndjson`, import.meta.url)
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => parseStreamLine(line))
}

/**
 * A real, never-exiting child standing in for the real CLI after a hook deny (M5 live-gate
 * finding 1): the real `claude` process does not exit on a deny -- it treats it as an ordinary
 * tool error and keeps working. `fromArray`'s synthetic stream already matches that shape (it
 * sends no `terminated` event after `hook_denied`); what it cannot exercise on its own is whether
 * something actually kills the process the pid names. This spawns one so that part can be
 * asserted on directly, the same way `adapter-resume.test.ts`'s live-pid tests do.
 */
async function spawnNeverExiting(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('spawnNeverExiting: child did not receive a pid')
  return child.pid
}

/**
 * A real child that IGNORES SIGTERM for longer than `killWithEscalation`'s 2 000 ms grace, so the
 * window between "the kill was sent" and "the pid is gone" is long enough to observe from another
 * task. `spawnNeverExiting` above dies on the first SIGTERM and cannot exercise this.
 */
async function spawnSigtermIgnoring(): Promise<number> {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)"],
    { stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('spawnSigtermIgnoring: child did not receive a pid')
  return child.pid
}

/** Polls the DB until `probe` is true, or throws naming what it last saw. */
async function until(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

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
  tokens: null,
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

  it('moves a resumed run from resuming to working on session_started, not only a fresh run from starting (gate-fix B review round 1, Critical 1)', async (): Promise<void> => {
    // `resuming` is what the tick's paused->resuming claim leaves the row at (`resume.ts` writes
    // only pid/pauseReason/pausedAtStep, never the status itself) -- this `session_started` write
    // is the ONLY place the domain's `resuming --resumed--> working` edge is implemented. A pump
    // that only recognised `starting` here left every resumed run reading `resuming` for the rest
    // of its life, because the terminal-outcome write at the end of this file overwrites whatever
    // status it finds regardless of what happened in between.
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { status: 'resuming' } })

    let release = (): void => {}
    const held = new Promise<void>((res) => {
      release = res
    })

    async function* stalls(): AsyncIterable<RuntimeEvent> {
      yield { kind: 'session_started', sessionId: 's-resumed' }
      await held
      yield { kind: 'terminated', outcome: okOutcome }
    }

    const pumping = pumpRun({ ...ids, resumed: true, events: stalls() })

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
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Edit', summary: 'Edit /tmp/notes.txt' },
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

  it('forwards the parser-derived readable summary on run.tool_call, not the opaque toolUseId (M4 spec §1)', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'toolu_01UCoRZm85rNxfupNQPToZXL', toolName: 'Write', summary: 'Write note3.txt' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const toolCallEvent = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_tool_call' },
    })
    const payload = toolCallEvent.payload as { name: string; summary: string }
    expect(payload).toEqual({ name: 'Write', summary: 'Write note3.txt' })
    expect(payload.summary).not.toBe('toolu_01UCoRZm85rNxfupNQPToZXL')
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
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Write', summary: 'Write /tmp/beta.txt' },
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
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
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

  it('leaves the row pause_requested and run.paused unannounced until the child is actually dead', async (): Promise<void> => {
    const pid = await spawnSigtermIgnoring()
    await prisma.agentRun.update({
      where: { id: ids.runId },
      // `pause_requested` is what an operator's `requestPause` leaves behind; the deny below is the
      // gate answering it. This is the state Decision 1 is about.
      data: { pid, worktreePath: '/tmp', status: 'pause_requested' },
    })

    try {
      const pumping = pumpRun({
        ...ids,
        spawn: {
          settingsPath: '/tmp/settings.json',
          pauseFlagPath: '/tmp/pause.flag',
          hookPath: '/tmp/pause-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
          { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
        ]),
      })

      // The checkpoint is written FIRST (Decision 2), so its existence is the proof we are inside
      // the kill's grace window rather than before the branch ran at all.
      await until('the checkpoint to be written', async () => {
        return (await prisma.checkpoint.findUnique({ where: { runId: ids.runId } })) !== null
      })

      const during = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(during.status).toBe('pause_requested')
      expect(await eventTypesFor(ids.runId)).not.toContain('run.paused')
      expect(isAlive(pid)).toBe(true)

      await pumping

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(after.status).toBe('paused')
      expect(after.pausedAtStep).toBe(1)
      expect(await eventTypesFor(ids.runId)).toContain('run.paused')
      // The whole point: every consumer of `paused` may rely on the pid being gone.
      expect(isAlive(pid)).toBe(false)
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already dead -- that is the outcome under test.
      }
    }
  }, 30_000)

  it('reacts to a second hook deny after the pause only once, not with a second checkpoint write, kill and run.paused', async (): Promise<void> => {
    // Fix round 1: the real CLI does not exit promptly on SIGTERM (M5 live-gate finding 1's own
    // trace shows a second deny arriving after the first `run.paused` -- another Bash call denied
    // at atStep 6 following the one at atStep 5), and this pump's own `killWithEscalation` call
    // leaves a multi-second window open where the still-live child can trip the gate again. A
    // second `hook_denied` reaching this loop must not repeat the checkpoint write, the kill, or
    // the `run.paused` emit -- `paused` is already `true`, so the case is a no-op the second time.
    const pid = await spawnNeverExiting()
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid, worktreePath: '/tmp' } })

    try {
      const outcome = await pumpRun({
        ...ids,
        spawn: {
          settingsPath: '/tmp/settings.json',
          pauseFlagPath: '/tmp/pause.flag',
          hookPath: '/tmp/pause-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
          { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
          { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Bash', summary: 'Bash echo again' },
          { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
        ]),
      })

      expect(outcome).toBeNull()
      const types = await eventTypesFor(ids.runId)
      expect(types.filter((t) => t === 'run.paused')).toHaveLength(1)

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('paused')
      // Recorded at the first deny (atStep 1, after `tu_1`), not walked forward by the second.
      expect(run.pausedAtStep).toBe(1)

      expect(isAlive(pid)).toBe(false)
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already dead -- that is the point of the test.
      }
    }
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
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
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

  it('kills the run process once the checkpoint lands, so a real CLI that keeps working after a hook deny does not stay alive', async (): Promise<void> => {
    const pid = await spawnNeverExiting()
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid, worktreePath: '/tmp' } })

    try {
      const outcome = await pumpRun({
        ...ids,
        spawn: {
          settingsPath: '/tmp/settings.json',
          pauseFlagPath: '/tmp/pause.flag',
          hookPath: '/tmp/pause-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
          { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
        ]),
      })

      expect(outcome).toBeNull()
      expect(isAlive(pid)).toBe(false)

      // The checkpoint must have landed before the process was killed -- this only proves it
      // exists, `writeCheckpoint`'s own test proves its contents.
      await expect(prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })).resolves.toBeTruthy()

      // Recorded as a pause, not laundered into a failure by the stream ending with no
      // `terminated` event -- the same shape the fake CLI already produces after a deny, now true
      // of the real CLI too because the pump is what kills it.
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('paused')
      const types = await eventTypesFor(ids.runId)
      expect(types).toContain('run.paused')
      expect(types).not.toContain('run.failed')
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already dead -- that is the point of the test.
      }
    }
  })

  it('still kills the run process on a hook deny when no checkpoint could be written', async (): Promise<void> => {
    // No `spawn` facts and no prior `session_started` event: `writeCheckpoint` bails out with
    // "nothing could resume it" rather than writing a half checkpoint. The run cannot be resumed
    // by anyone either way, so the decision here is that killing still happens -- a run nobody
    // can resume is not an excuse to leave a live, ungated child behind; it is the opposite case,
    // since the checkpoint that would have let a careful operator watch for this can never exist.
    const pid = await spawnNeverExiting()
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid } })

    try {
      await pumpRun({
        ...ids,
        events: fromArray([{ kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' }]),
      })

      expect(isAlive(pid)).toBe(false)
      await expect(prisma.checkpoint.findUnique({ where: { runId: ids.runId } })).resolves.toBeNull()
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already dead -- that is the point of the test.
      }
    }
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

  it('concludes stopped, not failed, when the stream ends without a terminal result on a run a web stop already claimed', async (): Promise<void> => {
    // The M5 live-gate race (finding 2): `requestStop` claims the row `stopping` before it kills
    // the child, in another process. The kill wakes this pump's stream first -- the child is dead
    // before `requestStop`'s own conclusion runs -- so this branch, not `requestStop`, is the one
    // that writes the terminal row. It must write what the operator asked for, not a plain crash.
    //
    // Seeded with both `status: 'stopping'` AND the intent record, mirroring exactly what
    // `requestStop`'s own claim writes (gate-fix B review round 1, Critical 2): `stopping` alone
    // is what the guardrail sweep also claims, and is covered by its own, separate test below.
    await prisma.agentRun.update({
      where: { id: ids.runId },
      data: { status: 'stopping', stopRequestedBy: 'meren', stopRequestedAt: new Date() },
    })

    const outcome = await pumpRun({
      ...ids,
      events: fromArray([{ kind: 'session_started', sessionId: 's-1' }]),
    })

    expect(outcome).toBeNull()
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('stopped')
    expect(run.terminalAt).not.toBeNull()
    expect(run.endedAt).not.toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.stopped')
    expect(types).not.toContain('run.failed')
    // Important 3: the requester's name must survive to the event the pump writes, not just the
    // one `requestStop` writes when it wins the race -- an operator reading the transcript must
    // see who stopped the run either way.
    const stoppedEvent = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: ids.runId, type: 'run_stopped' },
    })
    expect((stoppedEvent.payload as { reason: string }).reason).toContain('meren')
  })

  it('still concludes failed, not stopped, when the guardrail sweep claims stopping with no recorded stop intent', async (): Promise<void> => {
    // Gate-fix B review round 1, Critical 2: `sweep.ts`'s timeout/tool-cap guardrail claims the
    // exact same `stopping` status ahead of its own `adapter.cancel`, and writes no terminal row
    // of its own -- it relies on this branch. Before this test existed, nothing distinguished that
    // claim from an operator's, and this branch had started concluding it `stopped`: `world.ts`
    // reads `stopped` as `terminal_uncounted`, so a guardrail kill would silently stop counting
    // toward `consecutiveFailures` and the circuit breaker could never trip on a gate that keeps
    // timing out or blowing the tool cap.
    await prisma.agentRun.update({ where: { id: ids.runId }, data: { status: 'stopping' } })

    const outcome = await pumpRun({
      ...ids,
      events: fromArray([{ kind: 'session_started', sessionId: 's-1' }]),
    })

    expect(outcome).toBeNull()
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('failed')
    expect(run.terminalAt).not.toBeNull()
    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.failed')
    expect(types).not.toContain('run.stopped')
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
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Edit', summary: 'Edit /tmp/notes.txt' },
        { kind: 'tool_call', toolUseId: 'tu_3', toolName: 'Bash', summary: 'Bash echo hi' },
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
        { kind: 'tool_call', toolUseId: 'tu_4', toolName: 'Bash', summary: 'Bash echo hi' },
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

  /**
   * M14 §4.1 / Decisions 4 and 5: `AgentRun.skillCalls`.
   *
   * The tally comes from the `tool_call` events the pump loop already sees -- no new
   * `RuntimeEvent` variant, no second pass over the stream -- and is written ONCE per pump, when
   * that pump's STREAM ENDS, whatever ended it. Fix round 1 moved it there from the row's four
   * terminal status writes, because those two are different events: `packages/control/src/stop.ts`
   * concludes an operator-stopped run from another package with no tally in hand and normally wins
   * the race, and a pause writes no conclusion at all. What these tests pin is that single write,
   * its merge, and the three-state column -- a tally, a measured `{}`, and a `null` that means
   * "this runtime cannot report", keyed on the PROVIDER rather than on what the stream contained.
   */
  describe('skillCalls (M14 §4.1)', () => {
    const skillCall = (id: string, name: string): RuntimeEvent => ({
      kind: 'tool_call',
      toolUseId: id,
      toolName: 'Skill',
      // `Skill <name>` is exactly what `summaryFor` emits for a recorded `Skill` tool_use --
      // measured in `packages/providers/test/fixtures/claude/skill-tool-use.ndjson` and asserted
      // in `stream.test.ts`. These fixtures must keep matching that shape or they are testing a
      // string the parser never produces.
      summary: `Skill ${name}`,
    })

    it('tallies Skill tool calls and writes them when the run concludes cleanly', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:writing-plans'),
          { kind: 'tool_call', toolUseId: 't2', toolName: 'Write', summary: 'Write a.txt' },
          skillCall('t3', 'superpowers:writing-plans'),
          skillCall('t4', 'superpowers:test-driven-development'),
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('succeeded')
      expect(run.skillCalls).toEqual({
        'superpowers:writing-plans': 2,
        'superpowers:test-driven-development': 1,
      })
      // The non-Skill call is counted as a tool call and NOT as a skill: the two counters read the
      // same events and must not be the same number.
      expect(run.toolCalls).toBe(4)
    })

    it('writes the measured empty tally for a run that invoked no skill', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 't1', toolName: 'Write', summary: 'Write a.txt' },
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      // `{}`, not null: this run WAS measured and used no skill. `null` is reserved for a runtime
      // that cannot report (M14 Decision 4).
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.skillCalls).toEqual({})
      expect(run.skillCalls).not.toBeNull()
    })

    it('counts a Skill call the CLI did not name rather than dropping it', async (): Promise<void> => {
      // `summaryFor` falls back to the bare tool name when the tool_use carries no readable
      // argument. A `Skill` call in that state is still a skill call that happened; silently
      // dropping it would make the tally quietly under-report, which is worse than a visible
      // `<unnamed>` bucket an operator can ask about.
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 't1', toolName: 'Skill', summary: 'Skill' },
          skillCall('t2', 'superpowers:brainstorming'),
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.skillCalls).toEqual({ '<unnamed>': 1, 'superpowers:brainstorming': 1 })
    })

    it('writes the tally on the failure path too, not only on success', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:brainstorming'),
          { kind: 'terminated', outcome: { ...okOutcome, isError: true } },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('failed')
      expect(run.skillCalls).toEqual({ 'superpowers:brainstorming': 1 })
    })

    it('writes the tally when the stream ends with no terminal event', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:verification-before-completion'),
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('failed')
      expect(run.skillCalls).toEqual({ 'superpowers:verification-before-completion': 1 })
    })

    it('writes the tally when a broken gate concludes the run', async (): Promise<void> => {
      // `hook_failed_open` halts the workspace and concludes the run `failed` from inside the loop.
      // The write is still the one at the stream's end, which the loop reaches afterwards -- and it
      // has to land on a row this pump itself already marked terminal.
      await pumpRun({
        ...ids,
        cancel: async (): Promise<void> => {},
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:test-driven-development'),
          { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: 'gate is broken' },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('failed')
      expect(run.skillCalls).toEqual({ 'superpowers:test-driven-development': 1 })
    })

    it('keeps the tally when requestStop concluded the row before the stream ended (review Important 1)', async (): Promise<void> => {
      // THE case fix round 1 exists for, and the one the previous round lost. `requestStop`
      // (`packages/control/src/stop.ts`) claims `stopping`, kills the child, and writes the
      // terminal row itself -- `{ status: 'stopped', terminalAt, endedAt }`, from another package,
      // with no tally in hand. `pump.ts`'s own comment says that side normally wins in the CLI, so
      // a tally carried only on this file's status-conditioned writes was measured and discarded
      // on the most common deliberate stop there is.
      //
      // Modelled here as the real thing does it: the row is already terminal, concluded by someone
      // else, when the pump's stream ends. The write must land anyway -- unconditioned on
      // `endedAt` and on status.
      async function* stopsMidStream(): AsyncIterable<RuntimeEvent> {
        yield { kind: 'session_started', sessionId: 's-1' }
        yield skillCall('t1', 'superpowers:systematic-debugging')
        const now = new Date()
        await prisma.agentRun.updateMany({
          where: { id: ids.runId, endedAt: null },
          data: { status: 'stopping', stopRequestedBy: 'meren', stopRequestedAt: now },
        })
        await prisma.agentRun.updateMany({
          where: { id: ids.runId, endedAt: null },
          data: { status: 'stopped', terminalAt: now, endedAt: now },
        })
      }

      await pumpRun({ ...ids, events: stopsMidStream() })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      // The other side's conclusion stands -- this write must not walk the status back.
      expect(run.status).toBe('stopped')
      expect(run.skillCalls).toEqual({ 'superpowers:systematic-debugging': 1 })
    })

    it('writes the tally on a pause, and the resumed pump adds to it instead of replacing it', async (): Promise<void> => {
      // A pause writes no conclusion, so a tally that waited for one lost the whole first half of
      // every paused run -- and the resume seed had nothing to read. Now the pause's own stream end
      // writes it, and this is the production flow end to end: pause, resume, one total.
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:brainstorming'),
          { kind: 'hook_denied', hookName: 'PreToolUse:Write', reason: 'Paused by AI Team OS.' },
        ]),
      })

      const paused = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(paused.status).toBe('paused')
      // A pause is not a conclusion, but it IS a stream end: what the run did before it is a fact.
      expect(paused.endedAt).toBeNull()
      expect(paused.skillCalls).toEqual({ 'superpowers:brainstorming': 1 })

      // What the tick's paused->resuming claim leaves the row at before `resume()` pumps again.
      await prisma.agentRun.update({ where: { id: ids.runId }, data: { status: 'resuming' } })

      await pumpRun({
        ...ids,
        resumed: true,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t2', 'superpowers:brainstorming'),
          skillCall('t3', 'superpowers:writing-plans'),
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('succeeded')
      // Merged, not replaced: the second pump counted only its own two calls.
      expect(run.skillCalls).toEqual({
        'superpowers:brainstorming': 2,
        'superpowers:writing-plans': 1,
      })
    })

    it('writes null, never an empty tally, for a Cursor run -- that runtime cannot report skills', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        // The PROVIDER is the discriminator, not the stream: this run's event list is identical to
        // the "invoked no skill" Claude case above, and the column must come out differently.
        spawn: {
          settingsPath: '/tmp/aiteamos-skillcalls/.cursor/hooks.json',
          pauseFlagPath: '/tmp/aiteamos-skillcalls/pause.flag',
          hookPath: '/opt/aiteamos/cursor-shell-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@example.com' },
          provider: 'cursor',
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'tool_call', toolUseId: 't1', toolName: 'Write', summary: 'Write a.txt' },
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('succeeded')
      expect(run.skillCalls).toBeNull()
    })

    it('applies the tally exactly once per stream end, however the row was concluded', async (): Promise<void> => {
      // "Exactly once" is observable through the merge: the write reads the row back and ADDS, so
      // a second write on any other path -- the four terminal status writes this replaced, say --
      // would read its own first result and double every count. One Skill call must therefore come
      // out as 1, on the path where the row is concluded from inside the loop and the stream end
      // arrives afterwards.
      //
      // Not asserted with `vi.spyOn(prisma.agentRun, 'updateMany')`: measured here, spying on a
      // Prisma model method records the call but does NOT call through (it returns `undefined`),
      // so the probe would silently suppress the very write it claims to count.
      await pumpRun({
        ...ids,
        cancel: async (): Promise<void> => {},
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          skillCall('t1', 'superpowers:brainstorming'),
          { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: 'gate is broken' },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('failed')
      expect(run.skillCalls).toEqual({ 'superpowers:brainstorming': 1 })
    })
  })

  /**
   * M14 §4.2, narrowed by M15 spec §4 (fix round 1): `AgentRun.tokensIn` / `tokensOut`, written
   * from `RunOutcome.tokens` at the same stream-end write `skillCalls` uses, NOT the terminal
   * `succeeded`/`failed` write -- tokens are a fact of the `result` line, which only that write
   * ever has in hand. Unlike `skillCalls`, which is unconditional every time the stream ends,
   * this write is conditioned on the stream having actually produced a `result` line: a pause or
   * an operator's kill carries no `outcome` at all, and writing `null` onto the row then would
   * erase a total an earlier pump of this same run already recorded.
   *
   * Unlike `skillCalls`, this column is NOT provider-gated: M14 Decision 4's `Cursor -> null`
   * provider rule is superseded here by M15 spec §4. `outcome.tokens` is persisted whenever it
   * is non-null, for any provider -- see the Cursor case below.
   */
  describe('AgentRun.tokensIn / tokensOut (M14 §4.2, M15 spec §4)', () => {
    it('writes the reported token counts beside the cost when the run concludes', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'terminated', outcome: { ...okOutcome, tokens: { input: 4, output: 741 } } },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.tokensIn).toBe(4)
      expect(run.tokensOut).toBe(741)
    })

    it('leaves both token columns null for a runtime that reported none', async (): Promise<void> => {
      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          // okOutcome's own tokens is already null -- a degraded or otherwise unmeasured result.
          { kind: 'terminated', outcome: okOutcome },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.tokensIn).toBeNull()
      expect(run.tokensOut).toBeNull()
    })

    it('writes a Cursor run’s reported tokens too -- M15 spec §4 supersedes the provider rule for tokens only, leaving skillCalls null', async (): Promise<void> => {
      // M15 fix round 1: unlike `skillCalls` just above, `tokensIn`/`tokensOut` are no longer
      // gated on `runtimeReportsUsage`/the provider. A non-null `outcome.tokens` is a measurement
      // the stream actually reported -- here, the exact figures `cursor/stream.ts`'s
      // `tokensFromUsage` derives from the recorded fixture's result line
      // (`inputTokens:15391 + cacheReadTokens:25856 + cacheWriteTokens:0 = 41247`, `outputTokens:223`)
      // -- and it is persisted for any provider. `skillCalls` still stays SQL NULL: Cursor
      // genuinely never emits a `Skill` tool call, and that rule (Decision 4) is untouched.
      await pumpRun({
        ...ids,
        spawn: {
          settingsPath: '/tmp/aiteamos-tokens/.cursor/hooks.json',
          pauseFlagPath: '/tmp/aiteamos-tokens/pause.flag',
          hookPath: '/opt/aiteamos/cursor-shell-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@example.com' },
          provider: 'cursor',
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'terminated', outcome: { ...okOutcome, tokens: { input: 41247, output: 223 } } },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.tokensIn).toBe(41247)
      expect(run.tokensOut).toBe(223)
      expect(run.skillCalls).toBeNull()
    })

    it('does not null out an already-written total when a later stream ends with no result line', async (): Promise<void> => {
      // Sets up the state a resumed run's SECOND pump would find: a total already on the row
      // from an earlier conclusion. This pump's own stream then ends on a pause -- no `result`
      // line, so no `outcome` -- and the earlier figure must survive that write, not be
      // overwritten with `null`.
      await prisma.agentRun.update({ where: { id: ids.runId }, data: { tokensIn: 10, tokensOut: 20 } })

      await pumpRun({
        ...ids,
        events: fromArray([
          { kind: 'session_started', sessionId: 's-1' },
          { kind: 'hook_denied', hookName: 'PreToolUse:Write', reason: 'Paused by AI Team OS.' },
        ]),
      })

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('paused')
      expect(run.tokensIn).toBe(10)
      expect(run.tokensOut).toBe(20)
    })
  })

  /**
   * M18 Task 6: the streams and the pump must tell a MATRIX deny (the run continues) from a PAUSE
   * deny (the run stops) apart, and a matrix deny gets its own `run.tool_denied` event instead.
   *
   * Both tests here run their fixture through `eventsFromFixture` -- the REAL Claude stream parser
   * (`@ai-team-os/providers`'s `parseStreamLine`), not a hand-authored `RuntimeEvent` array -- so
   * the fixture's own reason string, prefix and all, is what proves the routing, not a stand-in
   * for it. `classifyGateEvent`'s prefix check sits between the two: the fixture's raw NDJSON goes
   * in, `pumpRun`'s observable effects come out.
   */
  describe('permission-matrix denials vs pause denials (M18 Task 6)', () => {
    it('runs a matrix-denied Bash call to completion: succeeded, never paused, no kill, one run.tool_denied, no guardrail.tripped, no denied tool use ids', async (): Promise<void> => {
      const pid = await spawnNeverExiting()
      await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid, worktreePath: '/tmp' } })

      try {
        const outcome = await pumpRun({ ...ids, events: fromArray(eventsFromFixture('permission-matrix-deny')) })

        // The run reached its own conclusion -- a matrix deny does not stop the stream, so
        // `terminated` still arrives and `pumpRun` still returns its outcome.
        expect(outcome).not.toBeNull()
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
        expect(run.status).toBe('succeeded')
        // Never paused: the whole point of Task 6 is that a matrix deny is not the pause protocol.
        expect(run.pausedAtStep).toBeNull()

        const types = await eventTypesFor(ids.runId)
        expect(types).not.toContain('run.paused')
        expect(types.filter((t) => t === 'run.tool_denied')).toHaveLength(1)
        expect(types).not.toContain('guardrail.tripped')

        const toolDenied = await prisma.executionEvent.findFirstOrThrow({
          where: { runId: ids.runId, type: 'run_tool_denied' },
        })
        expect(toolDenied.payload).toEqual({ tool: 'Bash', capability: 'run tests' })

        // No kill: `killWithEscalation` is reached only from the `stopped_by_gate` branch, which a
        // matrix deny never takes. The never-exiting child is still alive to prove it -- the same
        // shape this file's own pause-path kill tests use, in the other direction.
        expect(isAlive(pid)).toBe(true)

        // No checkpoint: nothing paused, so nothing had a reason to write one.
        await expect(prisma.checkpoint.findUnique({ where: { runId: ids.runId } })).resolves.toBeNull()
      } finally {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already dead -- not the point of this test either way.
        }
      }
    })

    it('regression: hook-deny.ndjson through the real parser still pauses, exactly as before Task 6', async (): Promise<void> => {
      const pid = await spawnNeverExiting()
      await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid, worktreePath: '/tmp' } })

      try {
        const outcome = await pumpRun({
          ...ids,
          spawn: {
            settingsPath: '/tmp/settings.json',
            pauseFlagPath: '/tmp/pause.flag',
            hookPath: '/tmp/pause-gate.sh',
            gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
          },
          events: fromArray(eventsFromFixture('hook-deny')),
        })

        // Same shape `stopped_by_gate` has always produced (M13 Decisions 1-2): the pump kills the
        // still-running child and pauses the row -- byte-identical to the pre-Task-6 behaviour,
        // because this fixture's own deny reason ("Paused by AI Team OS. Stop and wait.") carries
        // no matrix prefix, so `classifyGateEvent` still routes it to `stopped_by_gate`, not the
        // new `tool_denied` kind.
        expect(outcome).toBeNull()
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
        expect(run.status).toBe('paused')
        // Two tool_call events precede the deny in this recording (Read, then the denied Edit) --
        // unlike the hand-authored single-tool-call pause tests above.
        expect(run.pausedAtStep).toBe(2)

        const types = await eventTypesFor(ids.runId)
        expect(types).toContain('run.paused')
        expect(types).not.toContain('run.tool_denied')
        expect(types).not.toContain('guardrail.tripped')

        expect(isAlive(pid)).toBe(false)
        await expect(prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })).resolves.toBeTruthy()
      } finally {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already dead -- that is the point of this test.
        }
      }
    })

    it('a Cursor matrix denial does not poison the pause-real heuristic: run.tool_denied emitted, denied left empty, no guardrail.tripped, the matrix id excluded from the terminal failure check (fix round 1, review Important 2 + Critical 1)', async (): Promise<void> => {
      // Seeded `pause_requested`, deliberately: `recordCursorPauseIfRequested` (:397) only even
      // looks at its own early-return when this status is armed by an in-flight operator pause
      // request. This proves the heuristic itself survives a matrix denial mid-run -- a
      // clean-terminal Cursor run whose only denial was the matrix's own must NOT be reclassified
      // as paused just because a pause was requested while it was finishing.
      await prisma.agentRun.update({
        where: { id: ids.runId },
        data: { status: 'pause_requested', worktreePath: '/tmp' },
      })

      const matrixReason = "permission matrix denies 'run tests' (shell) for this agent"
      const outcome = await pumpRun({
        ...ids,
        spawn: {
          settingsPath: '/tmp/aiteamos-cursor-matrix/.cursor/hooks.json',
          pauseFlagPath: '/tmp/aiteamos-cursor-matrix/pause.flag',
          hookPath: '/opt/aiteamos/cursor-shell-gate.sh',
          gitIdentity: { name: 'Alex', email: 'alex@example.com' },
          provider: 'cursor',
        },
        events: fromArray([
          { kind: 'session_started', sessionId: 's-cursor-matrix' },
          { kind: 'permission_denied', toolName: 'shell', toolUseId: 'c1', reason: matrixReason },
          // `c1` echoed in `deniedToolUseIds` too -- the exact reason-blind shape
          // `cursor/adapter.ts`'s `rejectedCallIds` derivation produces for real (review Critical 1).
          { kind: 'terminated', outcome: { ...okOutcome, deniedToolUseIds: ['c1'] } },
        ]),
      })

      // Critical 1: `c1` is excluded from the failure check because THIS pump itself confirmed, via
      // a full parse of the matrix-prefixed reason, that it was a survivable refusal -- the run
      // concludes on its own merits, not failed by the CLI's reason-blind denial echo.
      expect(outcome).not.toBeNull()
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
      expect(run.status).toBe('succeeded')
      // NOT reclassified as paused despite the `pause_requested` seed: `recordCursorPauseIfRequested`
      // saw a clean terminal outcome AND an empty `denied` (the matrix branch never pushes into it),
      // so its own early-return fired before the pause claim was even attempted.
      expect(run.pausedAtStep).toBeNull()

      const types = await eventTypesFor(ids.runId)
      expect(types).not.toContain('run.paused')
      expect(types.filter((t) => t === 'run.tool_denied')).toHaveLength(1)
      expect(types).not.toContain('guardrail.tripped')

      const toolDenied = await prisma.executionEvent.findFirstOrThrow({
        where: { runId: ids.runId, type: 'run_tool_denied' },
      })
      expect(toolDenied.payload).toEqual({ tool: 'shell', capability: 'run tests' })

      await expect(prisma.checkpoint.findUnique({ where: { runId: ids.runId } })).resolves.toBeNull()
    })

    it('pauses, does not tool_deny, on a hook_denied reason that only starts with the matrix prefix but fails to parse (fix round 1, review Important 4 controller ruling: fail-safe is pausing)', async (): Promise<void> => {
      const pid = await spawnNeverExiting()
      await prisma.agentRun.update({ where: { id: ids.runId }, data: { pid, worktreePath: '/tmp' } })

      try {
        // Carries the prefix -- so a pre-fix-round-1 `classifyGateEvent` would have reported
        // `tool_denied` with the `unknown`/`unknown` fallback -- but the tail does not match the
        // grammar `parsePermissionDenyReason` requires.
        const malformedReason = `${PERMISSION_DENY_REASON_PREFIX} nonsense`
        const outcome = await pumpRun({
          ...ids,
          spawn: {
            settingsPath: '/tmp/settings.json',
            pauseFlagPath: '/tmp/pause.flag',
            hookPath: '/tmp/pause-gate.sh',
            gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
          },
          events: fromArray([
            { kind: 'session_started', sessionId: 's-1' },
            { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
            { kind: 'hook_denied', hookName: 'PreToolUse:Bash', reason: malformedReason },
          ]),
        })

        // Fail-safe is pausing: an unparseable claim of "this was the matrix" is treated exactly
        // like an ordinary pause deny, not trusted merely because it looks like one.
        expect(outcome).toBeNull()
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
        expect(run.status).toBe('paused')
        expect(run.pausedAtStep).toBe(1)

        const types = await eventTypesFor(ids.runId)
        expect(types).toContain('run.paused')
        expect(types).not.toContain('run.tool_denied')

        expect(isAlive(pid)).toBe(false)
        const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
        expect(checkpoint.pauseReason).toBe(malformedReason)
      } finally {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already dead -- that is the point of this test.
        }
      }
    })
  })
})
