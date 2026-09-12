import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { CONSTRAIN_GRACE_CALLS, steerTextFor } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { constrainRun, deliverBreakerSteer, steerRun } from '../../src/breaker.js'

/**
 * THE PUMP, MADE DETERMINISTIC -- the one seam in this file (M52 final review, the `steerRun` race).
 *
 * `steerRun` writes twice and the window between the writes is real: `requestPause` signals a pause
 * the daemon's pump is already watching for, and the pump can park the run (`paused`) or the run can
 * conclude before the second statement lands. Neither is reachable from a test that only calls the
 * verb, so the module boundary `steerRun` itself uses is the place to stand: the ORIGINAL
 * `requestPause` runs, untouched, and one extra write happens in the window afterwards -- exactly
 * what the other process would have done. Both flags are null for every other case in this file, so
 * nothing else here is mocked in any sense that matters.
 */
let parkDuringPause: string | null = null
let concludeDuringPause: string | null = null

vi.mock('../../src/pause.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pause.js')>()
  return {
    ...actual,
    requestPause: async (...args: Parameters<typeof actual.requestPause>) => {
      const result = await actual.requestPause(...args)
      if (parkDuringPause === args[0]) {
        await prisma.slaveRun.update({ where: { id: args[0] }, data: { status: 'paused' } })
      }
      if (concludeDuringPause === args[0]) {
        await prisma.slaveRun.update({ where: { id: args[0] }, data: { status: 'succeeded', endedAt: new Date() } })
      }
      return result
    },
  }
})

/**
 * The CONTROL half of the behavioural breaker (M51 R3), against a real database.
 *
 * `resume-intent.test.ts` is this file's nearest relative and the fixture below is its fixture: the
 * two verbs here ride the pause/resume round trip that file already pins, so what is new is only
 * what the BREAKER adds to it -- who the pause is attributed to, what the steer counts, and the
 * marker that tells a steer waiting to be delivered from a person's own paused run.
 */
const BREAKER_TEXT = steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:deadbeef' })

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly slaveId: string
  readonly repoPath: string
}

let fixture: Fixture

async function seed(): Promise<Fixture> {
  // A real directory: `requestPause` writes the run's pause flag under `<repoPath>/.slaveofai`, and
  // a flag it cannot write is a `pause_unsignalled` refusal rather than the claim these cases are
  // about.
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-breaker-'))
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add checkout retry',
      description: 'Retry failed payments',
      status: 'running',
      maxAttempts: workspace.maxAttempts,
    },
  })
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id, repoPath }
}

async function workingRun(
  over: {
    readonly status?: 'working' | 'paused' | 'succeeded' | 'pause_requested'
    readonly toolCalls?: number
    readonly breakerSteers?: number
    readonly breakerLevel?: 'none' | 'steered' | 'constrained'
  } = {},
): Promise<{ readonly id: string }> {
  return prisma.slaveRun.create({
    data: {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: over.status ?? 'working',
      toolCalls: over.toolCalls ?? 0,
      breakerSteers: over.breakerSteers ?? 0,
      breakerLevel: over.breakerLevel ?? 'none',
    },
    select: { id: true },
  })
}

/** The checkpoint `requestResume` refuses a run without -- the shape a real pause leaves behind. */
async function checkpointFor(runId: string): Promise<void> {
  await prisma.checkpoint.create({
    data: {
      runId,
      sessionId: 'session-123',
      worktreePath: join(fixture.repoPath, 'worktree'),
      pauseFlagPath: join(fixture.repoPath, '.slaveofai', 'runs', runId, 'pause.flag'),
      settingsPath: join(fixture.repoPath, '.slaveofai', 'runs', runId, 'settings.json'),
      hookPath: join(fixture.repoPath, 'scripts', 'pause-gate.sh'),
      gitAuthorName: 'Alex',
      gitAuthorEmail: 'alex@slaveofai.local',
      headCommit: 'a1b2c3d4',
    },
  })
}

/** A run the breaker steered and the pump has since actually parked: phase B's whole subject. */
async function steeredAndParked(): Promise<{ readonly id: string }> {
  const run = await prisma.slaveRun.create({
    data: {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: 'paused',
      pauseReason: 'guardrail',
      queuedMessage: BREAKER_TEXT,
      breakerLevel: 'steered',
      breakerTrips: 1,
      breakerSteers: 1,
    },
    select: { id: true },
  })
  await checkpointFor(run.id)
  return run
}

/** A person's paused run, with an instruction of their own queued on it. */
async function pausedByAPerson(): Promise<{ readonly id: string }> {
  const run = await prisma.slaveRun.create({
    data: {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: 'paused',
      pauseReason: 'human',
      queuedMessage: 'also create EXTRA.md',
    },
    select: { id: true },
  })
  await checkpointFor(run.id)
  return run
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('steerRun (M51 R3, phase A)', () => {
  it('claims the pause and queues the sentence in one call', async (): Promise<void> => {
    const run = await workingRun()
    const result = await steerRun(run.id, 'stop and rethink')
    expect(result.ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
    expect(after.queuedMessage).toBe('stop and rethink')
  })

  it('counts the steer on the run, so STEERS_PER_RUN_MAX survives a de-escalation', async (): Promise<void> => {
    const run = await workingRun({ breakerSteers: 1 })
    await steerRun(run.id, 'x')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).breakerSteers).toBe(2)
  })

  it('refuses a run that is not working, and writes NOTHING when it does', async (): Promise<void> => {
    const run = await workingRun({ status: 'paused' })
    const result = await steerRun(run.id, 'x')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('run_not_steerable')
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.queuedMessage).toBeNull()
    expect(after.breakerSteers).toBe(0)
  })

  it('refuses a run that does not exist', async (): Promise<void> => {
    expect((await steerRun('nope', 'x')).ok).toBe(false)
  })

  // THE TWO-STATEMENT RACE, PINNED (M52 final review). `requestPause` claims the pause and signals
  // it; the pump is watching that flag and can park the run at `paused` before the second statement
  // runs. With the narrower `status: 'pause_requested'` predicate that update matched NOTHING: the
  // sentence was dropped, the counter never moved, and the caller was told `run_not_steerable`
  // about a pause it really had claimed. `parkDuringPause` below is that pump, made deterministic
  // -- it does exactly what the pump does, in exactly the window the race needs.
  //
  // Not a `$transaction`, and that is the point of writing it this way: `requestPause` runs its own
  // `FOR UPDATE` raw statement on the global client and then writes a file and signals a pid, so
  // wrapping the pair would hold a row lock across real I/O and a rollback would leave the flag
  // written. Widening the predicate costs nothing and `deliverBreakerSteer` requires `paused` plus
  // a `queuedMessage` anyway.
  it('still queues the sentence when the pump parks the run at paused between the two statements', async (): Promise<void> => {
    const run = await workingRun()
    parkDuringPause = run.id
    try {
      const result = await steerRun(run.id, 'stop and rethink')
      expect(result.ok).toBe(true)
    } finally {
      parkDuringPause = null
    }
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('paused')
    expect(after.queuedMessage).toBe('stop and rethink')
    expect(after.breakerSteers).toBe(1)
  })

  it('still refuses a run that CONCLUDED between the two statements -- the widening is two statuses, not all of them', async (): Promise<void> => {
    const run = await workingRun()
    concludeDuringPause = run.id
    try {
      const result = await steerRun(run.id, 'x')
      expect(result.ok).toBe(false)
      expect(result.ok ? null : result.error.kind).toBe('run_not_steerable')
    } finally {
      concludeDuringPause = null
    }
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    // A message nobody will ever consume is the thing the predicate exists to refuse.
    expect(after.queuedMessage).toBeNull()
    expect(after.breakerSteers).toBe(0)
  })

  it('is the SYSTEM asking -- the pause event names the breaker, not a person', async (): Promise<void> => {
    const run = await workingRun()
    await steerRun(run.id, 'x')
    const [event] = await prisma.executionEvent.findMany({
      where: { runId: run.id, type: 'run_pause_requested' },
      orderBy: { seq: 'desc' },
      take: 1,
    })
    expect(event?.actor).toBe('system')
    expect((event?.payload as { requestedBy: string }).requestedBy).toBe('circuit breaker')
  })
})

describe('deliverBreakerSteer (M51 R3, phase B -- plan erratum E8)', () => {
  it('asks for the resume once the pump has actually parked the run', async (): Promise<void> => {
    const run = await steeredAndParked()
    expect((await deliverBreakerSteer(run.id)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.resumeRequestedAt).not.toBeNull()
    // The message survives the resume REQUEST -- `requestResume(id, null, ...)` must not erase what
    // phase A queued (`packages/control/src/resume.ts:121-127`). `claimResume` is what consumes it.
    expect(after.queuedMessage).toBe(BREAKER_TEXT)
  })

  it('records the resume as the SYSTEM’s, so it never lands in the web’s interventions filter', async (): Promise<void> => {
    const run = await steeredAndParked()
    await deliverBreakerSteer(run.id)
    const [event] = await prisma.executionEvent.findMany({
      where: { runId: run.id, type: 'run_resume_requested' },
      orderBy: { seq: 'desc' },
      take: 1,
    })
    expect(event?.actor).toBe('system')
    expect((event?.payload as { requestedBy: string }).requestedBy).toBe('circuit breaker')
  })

  it('refuses a run the breaker never armed -- a human’s paused run is not the breaker’s to resume', async (): Promise<void> => {
    const run = await pausedByAPerson()
    const result = await deliverBreakerSteer(run.id)
    expect(result.ok ? null : (result.error as { kind: string }).kind).toBe('breaker_not_armed')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).resumeRequestedAt).toBeNull()
  })

  it('is idempotent -- a second call on a run already asked to resume changes nothing', async (): Promise<void> => {
    const run = await steeredAndParked()
    await deliverBreakerSteer(run.id)
    const first = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect((await deliverBreakerSteer(run.id)).ok).toBe(false)
    const second = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(second.resumeRequestedAt?.getTime()).toBe(first.resumeRequestedAt?.getTime())
  })
})

describe('constrainRun (M51 R3)', () => {
  it('leaves the run exactly CONSTRAIN_GRACE_CALLS more calls, counted from where it is now', async (): Promise<void> => {
    const run = await workingRun({ toolCalls: 140 })
    expect((await constrainRun(run.id)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.toolCallCap).toBe(140 + CONSTRAIN_GRACE_CALLS)
    expect(after.breakerLevel).toBe('constrained')
  })

  it('re-reads the count under the row lock -- a call that landed mid-verb is not refunded', async (): Promise<void> => {
    // The cap is relative, so reading `toolCalls` before the lock would let a busy run gain calls
    // between the read and the write. One statement, `toolCalls + 30` computed by Postgres.
    const run = await workingRun({ toolCalls: 10 })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { toolCalls: { increment: 5 } } })
    await constrainRun(run.id)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).toolCallCap).toBe(
      15 + CONSTRAIN_GRACE_CALLS,
    )
  })

  it('never raises a cap it already wrote -- a second constrain is a no-op, not a refund', async (): Promise<void> => {
    const run = await workingRun({ toolCalls: 10 })
    await constrainRun(run.id)
    await prisma.slaveRun.update({ where: { id: run.id }, data: { toolCalls: { increment: 20 } } })
    await constrainRun(run.id)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).toolCallCap).toBe(
      10 + CONSTRAIN_GRACE_CALLS,
    )
  })

  it('refuses a run that is not working', async (): Promise<void> => {
    const run = await workingRun({ status: 'succeeded' })
    expect((await constrainRun(run.id)).ok).toBe(false)
  })

  it('says whether THIS call wrote the cap, so a re-constrain is not announced as a fresh grace', async (): Promise<void> => {
    const run = await workingRun({ toolCalls: 10 })
    const first = await constrainRun(run.id)
    expect(first.ok ? first.value : null).toEqual({ capSet: true })
    const second = await constrainRun(run.id)
    expect(second.ok ? second.value : null).toEqual({ capSet: false })
  })

  it('writes the LEVEL even when the cap already stands -- a relapse is still constrained', async (): Promise<void> => {
    // Fix round 1, Critical 1. The level used to ride inside the cap statement, under its
    // `toolCallCap IS NULL` guard, so the FIRST relapse after a recovery (constrained -> a healthy
    // beat -> steered -> a trip) updated nothing at all: the row stayed `steered`, the ladder
    // re-entered this same rung on every beat forever, and `escalate` never reached `'stop'`.
    const run = await workingRun({ toolCalls: 10 })
    await constrainRun(run.id)
    const capped = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    // The de-escalation a healthy beat writes: the WORD steps down, the cap stands (D16).
    await prisma.slaveRun.update({ where: { id: run.id }, data: { breakerLevel: 'steered' } })

    expect((await constrainRun(run.id)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.breakerLevel).toBe('constrained')
    expect(after.toolCallCap).toBe(capped.toolCallCap)
  })

  it('re-delivers the sentence when the caller supplies one, and caps either way', async (): Promise<void> => {
    // Spec R3: "constrainRun ... re-delivers the steer text through the same pause/resume round
    // trip" -- a constrained worker that was never told why would simply hit the ceiling in
    // silence. The text is the CALLER's, which is why it is a parameter and not derived here.
    const run = await workingRun({ toolCalls: 4 })
    expect((await constrainRun(run.id, CONSTRAIN_GRACE_CALLS, BREAKER_TEXT)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.queuedMessage).toBe(BREAKER_TEXT)
    expect(after.status).toBe('pause_requested')
    expect(after.toolCallCap).toBe(4 + CONSTRAIN_GRACE_CALLS)
    expect(after.breakerLevel).toBe('constrained')
  })
})
