import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import type { WorktreeProbe } from '@slave-of-ai/control'
import {
  BREAKER_BEAT_MS,
  CONSTRAIN_GRACE_CALLS,
  NO_PROGRESS_BEATS,
  REPEAT_TRIP_COUNT,
  workspaceId as brandWorkspaceId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteTickRan, reconcileOrphans, resetTickObservation, sweep, type SweepDeps } from '../../src/sweep.js'

/**
 * A pid that genuinely does not exist: a real child, spawned and reaped.
 *
 * `999999` was "certainly not running" only until a box passes a million spawns --
 * `/proc/sys/kernel/pid_max` is 4194304 here -- and a recycled pid inverts every orphan test in
 * this file silently, or worse, passes them for the wrong reason.
 */
let DEAD_PID = 0

beforeAll(async (): Promise<void> => {
  const child = spawn('/bin/sh', ['-c', 'exit 0'])
  DEAD_PID = child.pid ?? 0
  await new Promise<void>((res) => child.on('exit', () => res()))
})

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly slaveId: string
}

const dirs: string[] = []

async function seed(
  overrides: { readonly runTimeoutMs?: number; readonly name?: string; readonly repoPath?: string } = {},
): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: overrides.name ?? 'Checkout Platform',
      // `/tmp/checkout` need not exist for the passes above, which never touch the filesystem. The
      // breaker's CONSTRAIN rung does -- it pauses the run, and `requestPause` writes a flag under
      // the repo path -- so that describe passes a real directory (M51 R3).
      repoPath: overrides.repoPath ?? '/tmp/checkout',
      verifyCommands: ['true'],
      setupCommands: [],
      maxToolCallsPerRun: 200,
      ...(overrides.runTimeoutMs === undefined ? {} : { runTimeoutMs: overrides.runTimeoutMs }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

const hoursAgo = (n: number): Date => new Date(Date.now() - n * 60 * 60 * 1000)
const secondsAgo = (n: number): Date => new Date(Date.now() - n * 1000)

describe('sweep and reconcileOrphans', () => {
  let fixture: Fixture
  let deps: SweepDeps
  let cancelled: string[]
  let cancelThrows: boolean
  let concludeDuringCancel: boolean

  const givenRun = async (data: {
    status: 'working' | 'paused' | 'starting' | 'stopping' | 'succeeded' | 'failed' | 'pause_requested' | 'resuming'
    pid?: number | null
    toolCalls?: number
    startedAt?: Date
    worktreePath?: string
    taskId?: string
    kind?: 'implementation' | 'review' | 'planning'
  }) =>
    prisma.slaveRun.create({
      data: {
        taskId: data.taskId ?? fixture.taskId,
        slaveId: fixture.slaveId,
        status: data.status,
        ...(data.kind === undefined ? {} : { kind: data.kind }),
        pid: data.pid === undefined ? DEAD_PID : data.pid,
        toolCalls: data.toolCalls ?? 0,
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        ...(data.worktreePath === undefined ? {} : { worktreePath: data.worktreePath }),
      },
    })

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    cancelled = []
    cancelThrows = false
    concludeDuringCancel = false
    resetTickObservation()
    const adapter = {
      cancel: async (runId: string): Promise<void> => {
        cancelled.push(runId)
        // The real `cancel` awaits the child's exit, which is exactly the window in which the
        // pump writes the terminal row. Modelling that here is what makes the lost-update
        // observable from a test.
        if (concludeDuringCancel) {
          await prisma.slaveRun.update({
            where: { id: runId },
            data: { status: 'succeeded', terminalAt: new Date(), costUsd: 1.5 },
          })
        }
        if (cancelThrows) throw new Error('SIGTERM failed: process not registered')
      },
    } as unknown as SlaveRuntimeAdapter
    deps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      // `resolve` ignores `kind` and always hands back the one adapter this test configured --
      // the ordinary shape pre-Task-8, when every run resolves to `'claude_code'` regardless.
      registry: { resolve: () => adapter },
    }
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('marks a run failed when its pid is gone but its status is not terminal', async (): Promise<void> => {
    await givenRun({ status: 'working' })

    const count = await reconcileOrphans(deps)

    expect(count).toBe(1)
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    // The column `loadWorld` orders the failure streak by. An orphan concluded without it sorts by
    // `startedAt` instead, which is the mixed-clock case Task 10 carried forward.
    expect(run.terminalAt).not.toBeNull()
    expect(run.endedAt).not.toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['run.failed'])
  })

  it('reconciles a run that never got a pid at all', async (): Promise<void> => {
    // Task 13 creates the row and sets `pid` a moment later. A hard kill between those two writes
    // leaves `starting` with no pid and nothing that will ever conclude it -- and unlike a dead pid,
    // there is no process to ask about.
    await givenRun({ status: 'starting', pid: null })

    expect(await reconcileOrphans(deps)).toBe(1)
    expect((await prisma.slaveRun.findFirstOrThrow()).status).toBe('failed')
  })

  it('preserves the worktree of an orphaned run', async (): Promise<void> => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'slaveofai-sweep-'))
    dirs.push(worktreePath)
    await givenRun({ status: 'working', worktreePath })

    await reconcileOrphans(deps)

    // §7.4: the worktree is the inspection surface for a failed run, and an orphan is the case
    // where the operator most needs to see how far it got.
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('releases the task an orphaned run was holding', async (): Promise<void> => {
    const run = await givenRun({ status: 'working' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    await reconcileOrphans(deps)

    // Task 13 sets `status: running` and `activeRunId` when it starts a run. Failing the run and
    // leaving the task pointing at it strands the task exactly as Task 14's review found -- busy
    // forever, with nothing that reconciles tasks rather than runs.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.activeRunId).toBeNull()
    expect(task.status).toBe('rework')
  })

  // M41 Task 3b: a review run holds its task's claim now (`review.ts`'s dispatch), so this pass
  // releases one -- and what "release" means is not what it means for an implementation run. A
  // daemon that died is not the reviewer rejecting the work, and `rework` would spend an
  // implementation attempt re-doing work nobody has judged wrong. The task stays `reviewing` with a
  // null claim, which is exactly the state `dispatchReview` re-dispatches from.
  it('hands an orphaned review run claim back to reviewing, not to rework', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })
    const run = await givenRun({ status: 'working', kind: 'review' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    await reconcileOrphans(deps)

    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBeNull()
    expect(task.attempt).toBe(0)
    // No `task.rework`: the task did not go back into the implementation queue, and announcing that
    // it had would be a lie an operator reads off the timeline.
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'task_rework' } }),
    ).toBe(0)
  })

  it('leaves a paused run alone: it legitimately has no process', async (): Promise<void> => {
    await givenRun({ status: 'paused' })

    const count = await reconcileOrphans(deps)

    // A paused run's process was killed by the adapter on purpose -- that is what pausing *is*
    // (Task 8) -- so it presents with a dead pid and a non-terminal status, which is precisely the
    // orphan shape. Discriminating on liveness alone destroys every paused run in the fleet on the
    // first daemon restart, along with the checkpoint written to preserve it.
    expect(count).toBe(0)
    expect((await prisma.slaveRun.findFirstOrThrow()).status).toBe('paused')
  })

  it("leaves another workspace's runs alone", async (): Promise<void> => {
    const other = await seed({ name: 'Other Workspace' })
    await prisma.slaveRun.create({
      data: { taskId: other.taskId, slaveId: other.slaveId, status: 'working', pid: DEAD_PID },
    })

    expect(await reconcileOrphans(deps)).toBe(0)
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('working')
  })

  it('a workspace halt written by a gate failure survives the process that reconciles at startup', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'gate failure', haltedAt: new Date() },
    })
    // An orphan has to be present, or the pass has nothing to do and the property is asserted
    // against a loop that never ran -- which is how clearing the halt inside that loop survived
    // this test in its first form.
    await givenRun({ status: 'working' })
    expect(await reconcileOrphans(deps)).toBe(1)

    // Clearing a workspace halt is the operator's `clear-halt` (Task 16), never automatic: a halt
    // that cleared itself would be a delay, not a halt (§13.1). Re-reading the column is the whole
    // proof -- an in-memory latch would fail this assertion no matter which client did the reading,
    // which is why the plan's second `PrismaClient` bought nothing.
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(workspace.haltedReason).toBe('gate failure')
  })

  it('cancels a run past its wall-clock timeout', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })

    const report = await sweep(deps)

    expect(report.timedOut).toEqual([run.id])
    expect(cancelled).toEqual([run.id])
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['guardrail.tripped'])
  })

  it('cancels a run past the tool-call ceiling', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, toolCalls: 500 })

    const report = await sweep(deps)

    expect(report.overToolCap).toEqual([run.id])
    expect(cancelled).toEqual([run.id])
  })

  it('does not cancel the same run twice while it is dying', async (): Promise<void> => {
    await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })

    await sweep(deps)
    const afterFirst = (await eventTypesFor(fixture.workspaceId)).length
    await sweep(deps)

    // The sweep runs every tick. A run past its timeout that has not died yet would be re-cancelled
    // and re-announced once per second, forever, into an append-only log -- the same hazard §3.2
    // spends three paragraphs on for the halt command.
    expect(cancelled).toHaveLength(1)
    expect((await eventTypesFor(fixture.workspaceId)).length).toBe(afterFirst)
  })

  it('still reports and still announces when the cancel itself fails', async (): Promise<void> => {
    cancelThrows = true
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })

    const report = await sweep(deps)

    // Twice already in this milestone a failing cancel swallowed everything after it. A run that
    // could not be killed is the case an operator most needs to hear about.
    expect(report.timedOut).toEqual([run.id])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(events).toHaveLength(1)
    expect((events[0]?.payload as { detail: string }).detail).toMatch(/cancel failed/i)
  })

  it('leaves a run inside its limits alone', async (): Promise<void> => {
    await givenRun({ status: 'working', pid: process.pid, toolCalls: 3 })

    const report = await sweep(deps)

    expect(report).toEqual({
      timedOut: [],
      overToolCap: [],
      deadPids: [],
      strandedClaims: [],
      // M51 R2: the three breaker rungs join the report. Kept in this EXHAUSTIVE `toEqual` rather
      // than relaxed, so a fourth list still has to be looked at by somebody.
      breakerSteered: [],
      breakerConstrained: [],
      breakerStopped: [],
    })
    expect(cancelled).toEqual([])
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('concludes a run whose process is gone, as §3.3 requires', async (): Promise<void> => {
    const run = await givenRun({ status: 'working' })

    const report = await sweep(deps)

    // §3.3: "Dead pid -> the process is gone but the run is not terminal. Mark it failed, preserve
    // the worktree, emit run.failed." Only reporting it leaves no in-process path by which any run
    // is ever concluded: a run whose pump died, or whose process was killed externally, would stay
    // non-terminal with its slave busy and its task stranded until the next daemon restart, while
    // the sweep watched it every second and did nothing.
    expect(report.deadPids).toEqual([run.id])
    const row = await prisma.slaveRun.findFirstOrThrow()
    expect(row.status).toBe('failed')
    expect(row.terminalAt).not.toBeNull()
    expect(row.endedAt).not.toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['run.failed'])
  })

  // The other half of M41 Task 3b's sweep change: the per-tick dead-pid path releases a claim too,
  // and it has to release a review claim the same way `reconcileOrphans` does -- back to
  // `reviewing`, never to `rework`.
  it('hands a dead review run claim back to reviewing, not to rework', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })
    const run = await givenRun({ status: 'working', kind: 'review' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    await sweep(deps)

    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBeNull()
    expect(task.attempt).toBe(0)
  })

  it('leaves a dead-pid run alone while its pump is live in this process', async (): Promise<void> => {
    // A dead pid is the ordinary end of every run -- the child exits, then the pump writes the
    // terminal row a stream-drain later. Concluding the run in that window races the pump (the
    // M9 gate failure that forced this guard). Only a run NO live pump owns is an orphan.
    const run = await givenRun({ status: 'working' })

    const report = await sweep({ ...deps, livePumpRunIds: new Set([run.id]) })

    expect(report.deadPids).toEqual([])
    const row = await prisma.slaveRun.findFirstOrThrow()
    expect(row.status).toBe('working')
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('leaves a run that has not yet recorded its pid alone', async (): Promise<void> => {
    await givenRun({ status: 'starting', pid: null })

    const report = await sweep(deps)

    // The one shape the sweep must not act on: Task 13 creates the row and records the pid a moment
    // later, so a null pid mid-tick is a run about to spawn, not a dead one. Discriminating on the
    // pid rather than on liveness is what keeps §3.3 implementable from inside a running daemon.
    expect(report.deadPids).toEqual([])
    expect((await prisma.slaveRun.findFirstOrThrow()).status).toBe('starting')
  })

  it('does not resurrect a run the pump concluded while the cancel was in flight', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })
    // `cancel` awaits the child's exit, so by the time it returns the pump has very plausibly
    // already written the terminal row -- and a run at its wall-clock limit is exactly the kind
    // that is about to finish. An unguarded status write then rewrites `succeeded` back to
    // `stopping`: the slave reads busy forever, the task is never released, and the failure streak
    // never sees a run that actually concluded.
    concludeDuringCancel = true

    const report = await sweep(deps)

    // The conclusion lands *during* the cancel, so a cancel genuinely was issued and the report and
    // the event are honest about it. What must not survive is the status write: an unguarded one
    // rewrites `succeeded` back to `stopping` after the fact.
    const row = await prisma.slaveRun.findFirstOrThrow()
    expect(row.status).toBe('succeeded')
    expect(row.terminalAt).not.toBeNull()
    expect(report.timedOut).toEqual([run.id])
  })

  it('does nothing to a run the pump concluded before the sweep looked', async (): Promise<void> => {
    await givenRun({ status: 'succeeded', pid: process.pid, startedAt: hoursAgo(2) })

    const report = await sweep(deps)

    // The other half of the same race: a run already terminal is not swept at all, so no cancel is
    // issued and nothing announces one.
    expect(report).toEqual({
      timedOut: [],
      overToolCap: [],
      deadPids: [],
      strandedClaims: [],
      // M51 R2: the three breaker rungs join the report. Kept in this EXHAUSTIVE `toEqual` rather
      // than relaxed, so a fourth list still has to be looked at by somebody.
      breakerSteered: [],
      breakerConstrained: [],
      breakerStopped: [],
    })
    expect(cancelled).toEqual([])
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('sweeps a run that is pausing or resuming, not only one that is working', async (): Promise<void> => {
    await givenRun({ status: 'pause_requested', pid: process.pid, toolCalls: 500 })
    await givenRun({ status: 'resuming', pid: process.pid, toolCalls: 500 })

    const report = await sweep(deps)

    // Narrowing the list to `working` leaves a run that breached its ceiling mid-pause running past
    // it. Every other test here uses `working`, which is how such a narrowing goes unnoticed.
    expect(report.overToolCap).toHaveLength(2)
  })

  it('reconciles an orphan that was already stopping', async (): Promise<void> => {
    await givenRun({ status: 'stopping' })

    // R3's safety argument is that excluding `stopping` from the per-tick sweep is harmless because
    // the orphan pass still concludes it. That argument is the only thing making the exclusion
    // safe, and until now nothing tested it.
    expect(await reconcileOrphans(deps)).toBe(1)
    expect((await prisma.slaveRun.findFirstOrThrow()).status).toBe('failed')
  })

  it('names the guardrail for the limit that was actually breached', async (): Promise<void> => {
    await givenRun({ status: 'working', pid: process.pid, toolCalls: 500 })

    await sweep(deps)

    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect((event.payload as { guardrail: string }).guardrail).toBe('tool_call_ceiling')
  })

  it('correlates its events to the run, task and slave they are about', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })

    await sweep(deps)

    // Correlation is what M4 renders from: an event with a null runId is an event about nothing.
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(event.runId).toBe(run.id)
    expect(event.taskId).toBe(fixture.taskId)
    expect(event.slaveId).toBe(fixture.slaveId)
    expect(event.actor).toBe('system')
  })

  it('does not put a run in both report arrays for one breach', async (): Promise<void> => {
    await givenRun({ status: 'working', pid: process.pid, toolCalls: 500 })

    const report = await sweep(deps)

    expect(report.overToolCap).toHaveLength(1)
    expect(report.timedOut).toEqual([])
  })

  it('leaves a run exactly at its limits alone', async (): Promise<void> => {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    await givenRun({
      status: 'working',
      pid: process.pid,
      toolCalls: workspace.maxToolCallsPerRun,
      startedAt: new Date(Date.now() - workspace.runTimeoutMs + 5_000),
    })

    // A ceiling of 200 means 200 calls are allowed; a limit is breached when it is passed, not when
    // it is reached. Seeded away from the boundary, `>` and `>=` are indistinguishable.
    const report = await sweep(deps)

    expect(report).toEqual({
      timedOut: [],
      overToolCap: [],
      deadPids: [],
      strandedClaims: [],
      // M51 R2: the three breaker rungs join the report. Kept in this EXHAUSTIVE `toEqual` rather
      // than relaxed, so a fourth list still has to be looked at by somebody.
      breakerSteered: [],
      breakerConstrained: [],
      breakerStopped: [],
    })
  })

  it('counts only the runs it actually failed', async (): Promise<void> => {
    await givenRun({ status: 'working' })
    await givenRun({ status: 'working', pid: process.pid })

    // With a single orphan, "how many did I fail" and "how many did I look at" are the same number.
    expect(await reconcileOrphans(deps)).toBe(1)
  })

  it('leaves a task whose run has since been replaced alone', async (): Promise<void> => {
    const orphan = await givenRun({ status: 'working' })
    const replacement = await givenRun({ status: 'working', pid: process.pid })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: replacement.id } })

    await reconcileOrphans(deps)

    // The task is being worked on by a live run. Releasing it because an *older* run was orphaned
    // would hand the same task to a second slave while the first is still going -- the hazard Task
    // 13's atomic claim exists to prevent, arriving from the other direction.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.activeRunId).toBe(replacement.id)
    expect(task.status).toBe('running')
    void orphan
  })

  it('records that the task went back into the queue', async (): Promise<void> => {
    const run = await givenRun({ status: 'working' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    await reconcileOrphans(deps)

    // §13: no failure is silent. `failToStart` and `advance` both emit `task.rework` when they park
    // a task there; a reader of the log would otherwise see a run fail and no record of the task
    // returning to the queue.
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['run.failed', 'task.rework'])
  })

  it('treats a process it may not signal as alive', async (): Promise<void> => {
    // `process.kill(pid, 0)` throws EPERM for a process that exists but belongs to another user --
    // POSIX returns it *only* for a process that exists, so it is positive evidence of life and
    // reading it as death points the unsafe way. pid 1 is init: always there, rarely ours.
    await givenRun({ status: 'working', pid: 1 })

    expect(await reconcileOrphans(deps)).toBe(0)
    expect((await prisma.slaveRun.findFirstOrThrow()).status).toBe('working')
  })

  it('treats pid 0 as dead rather than as the whole process group', async (): Promise<void> => {
    // `kill(0, 0)` signals the caller's own process group and always succeeds, so a run recorded
    // with pid 0 would read as alive forever and never be reconcilable.
    await givenRun({ status: 'working', pid: 0 })

    expect(await reconcileOrphans(deps)).toBe(1)
  })

  it("leaves another workspace's runs out of the sweep too", async (): Promise<void> => {
    const other = await seed({ name: 'Other Workspace' })
    await prisma.slaveRun.create({
      data: {
        taskId: other.taskId,
        slaveId: other.slaveId,
        status: 'working',
        pid: process.pid,
        toolCalls: 500,
      },
    })

    const report = await sweep(deps)

    expect(report).toEqual({
      timedOut: [],
      overToolCap: [],
      deadPids: [],
      strandedClaims: [],
      // M51 R2: the three breaker rungs join the report. Kept in this EXHAUSTIVE `toEqual` rather
      // than relaxed, so a fourth list still has to be looked at by somebody.
      breakerSteered: [],
      breakerConstrained: [],
      breakerStopped: [],
    })
    expect(cancelled).toEqual([])
  })

  it('leaves a task alone when the sweep concludes an older run of it', async (): Promise<void> => {
    await givenRun({ status: 'working' })
    const replacement = await givenRun({ status: 'working', pid: process.pid })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: replacement.id } })

    await sweep(deps)

    // The same guard the orphan pass needs, on the path that runs every second rather than once at
    // startup: releasing a task because an older run died hands it to a second slave while the
    // first is still working.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.activeRunId).toBe(replacement.id)
    expect(task.status).toBe('running')
  })

  it('refuses to reconcile once a tick has run in this process', async (): Promise<void> => {
    noteTickRan()

    // The startup-only constraint is not a style preference: a null-pid run is legitimately
    // transient inside every startRun, so a reconcile racing a tick fails a run that is seconds
    // from spawning, releases its task to `rework`, and the next tick adopts the live run's
    // worktree with a second slave. Documented-only, that failure is silent.
    await expect(reconcileOrphans(deps)).rejects.toThrow(/startup/i)
  })

  it('recovers a task whose merge was interrupted by a crash mid-claim', async (): Promise<void> => {
    // Same shape as a run orphan -- a claim nothing will ever release -- but for a task's merge
    // claim rather than a run's pid, since the merge pass claims and processes in one call with no
    // row of its own to be seen mid-spawn.
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'merging', mergeClaimedAt: new Date() },
    })

    await reconcileOrphans(deps)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.mergeClaimedAt).toBeNull()
    expect(task.lastRejectionReason).toBe('merge interrupted')
    // No attempt increment: a dead daemon is not the slave failing.
    expect(task.attempt).toBe(0)
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['task.merge_failed'])
  })

  it('leaves a merging task with no claim alone', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'merging', mergeClaimedAt: null },
    })

    await reconcileOrphans(deps)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('merging')
    expect(task.mergeClaimedAt).toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })
  it('releases a task whose activeRunId names a terminal implementation run: rework, no attempt charged', async (): Promise<void> => {
    // The strand this arm exists for: `pumpRun` wrote the run terminal and the process died before
    // its chained `verifyConcludedRun` could release the task. Nothing else in the milestone looks
    // at a task whose claim points at a run that is already over.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id, attempt: 1 } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.activeRunId).toBeNull()
    // A daemon that died is not the slave failing -- `reconcileOrphans`' own rule.
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['task.rework'])
  })

  it('releases only the CLAIM of a task whose activeRunId names a terminal review run, leaving it reviewing', async (): Promise<void> => {
    const run = await givenRun({ status: 'failed', pid: process.pid, kind: 'review' })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBeNull()
    // `rework` would be a lie about where the task went AND an implementation attempt spent on work
    // nobody judged wrong, so no `task.rework` is announced for this kind (sweep.ts's own rule).
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('leaves a stranded claim alone while a pump in this process still owns the run', async (): Promise<void> => {
    // `activePumpRunIds.delete(runId)` runs in the pump chain's `.finally()`, AFTER
    // `verifyConcludedRun` -- so a run still in the set has not finished releasing its task.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep({ ...deps, livePumpRunIds: new Set([run.id]) })

    expect(report.strandedClaims).toEqual([])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).activeRunId).toBe(run.id)
  })

  it('leaves a claim alone until the run has been terminal for the grace period', async (): Promise<void> => {
    // A one-shot `tick` in ANOTHER process has an in-flight window this process's set cannot see.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: new Date(), endedAt: new Date() } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).activeRunId).toBe(run.id)
  })

  it('unclaims but does not rework a task that has already moved off running', async (): Promise<void> => {
    const run = await givenRun({ status: 'failed', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'blocked', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('blocked')
    expect(task.activeRunId).toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })
  // M42 t1 fix round 1 (spec E22): the grace is PER KIND. An implementation run's conclusion is not
  // over when its row goes terminal -- the chained `verifyConcludedRun` still has the workspace's
  // verify commands to run, up to `runTimeoutMs` each, before `advance()` releases the claim.
  it('leaves an implementation claim alone through the workspace\'s whole verify window', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { runTimeoutMs: 60_000, verifyCommands: ['true'] } })
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    // Past the flat 30 s, and nowhere near past 30 s + one 60 s verify command.
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: secondsAgo(31), endedAt: secondsAgo(31) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('running')
    expect(task.activeRunId).toBe(run.id)
  })

  it('releases an implementation claim once the verify window has passed too', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { runTimeoutMs: 60_000, verifyCommands: ['true'] } })
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: secondsAgo(91), endedAt: secondsAgo(91) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('rework')
  })

  it('releases a review claim on the flat grace alone: a review conclusion never runs a verify command', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { runTimeoutMs: 60_000, verifyCommands: ['true'] } })
    const run = await givenRun({ status: 'failed', pid: process.pid, kind: 'review' })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: secondsAgo(31), endedAt: secondsAgo(31) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBeNull()
  })

  it('does not rework a task that moved off running between the arm\'s read and its write', async (): Promise<void> => {
    // The race the `status` in the write's `where` exists for, made real: an operator's cancel (or
    // any other writer) lands after this arm has decided the task is `running` and before it
    // writes. Without that guard the write matches on `activeRunId` alone and drags the task back
    // to `rework` from wherever it had legitimately gone.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const realUpdateMany = prisma.task.updateMany.bind(prisma.task)
    const spy = vi.spyOn(prisma.task, 'updateMany')
    // Cast because `updateMany` is declared to return Prisma's own branded promise, which nothing
    // outside the client can construct; the arm only ever awaits it and reads `count`.
    spy.mockImplementation(((args: Parameters<typeof realUpdateMany>[0]) => {
      spy.mockRestore()
      return (async (): Promise<{ readonly count: number }> => {
        await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'cancelled' } })
        return realUpdateMany(args)
      })()
    }) as unknown as typeof prisma.task.updateMany)

    const report = await sweep(deps)
    spy.mockRestore()

    expect(report.strandedClaims).toEqual([])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('cancelled')
    expect(task.activeRunId).toBe(run.id)
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })
})

/**
 * The behavioural breaker's beat (M51 R2), end to end against a real database.
 *
 * Its own describe, with its own fixture: every case here needs a run with a LIVE pid and a window
 * of real `run.tool_call` / `run.tool_result` / `run.output` rows, which nothing above this line
 * has any use for. The detector itself is pinned purely in `packages/domain`; what these cases
 * exist for is the half that is not pure -- the beat clock, the ladder, what is written on every
 * beat including the ones that do nothing, and the delivery pass.
 */
describe('the breaker beat (M51 R2)', () => {
  let fixture: Fixture
  let deps: SweepDeps
  let cancelled: string[]
  /** A REAL directory: the constrain rung pauses the run, and `requestPause` writes a flag file
   *  under the workspace's repo path. A path that does not exist makes that verb throw. */
  let repoPath = ''

  /** A fingerprint probe with a fixed answer -- `null` is "could not measure". */
  const probeReturning = (value: string | null): WorktreeProbe => ({ fingerprint: async () => value })

  const givenBreakerRun = async (data: {
    status?: 'working' | 'pause_requested' | 'paused'
    pid?: number | null
    toolCalls?: number
    toolCallCap?: number | null
    startedAt?: Date
    breakerLevel?: 'none' | 'steered' | 'constrained'
    breakerTrips?: number
    breakerSteers?: number
    queuedMessage?: string
    pauseReason?: 'human' | 'guardrail'
    worktreePath?: string
  }) =>
    prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: data.status ?? 'working',
        pid: data.pid === undefined ? process.pid : data.pid,
        toolCalls: data.toolCalls ?? 0,
        ...(data.toolCallCap === undefined ? {} : { toolCallCap: data.toolCallCap }),
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        ...(data.breakerLevel === undefined ? {} : { breakerLevel: data.breakerLevel }),
        ...(data.breakerTrips === undefined ? {} : { breakerTrips: data.breakerTrips }),
        ...(data.breakerSteers === undefined ? {} : { breakerSteers: data.breakerSteers }),
        ...(data.queuedMessage === undefined ? {} : { queuedMessage: data.queuedMessage }),
        ...(data.pauseReason === undefined ? {} : { pauseReason: data.pauseReason }),
        ...(data.worktreePath === undefined ? {} : { worktreePath: data.worktreePath }),
      },
    })

  const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

  /** One answered tool call, written the way the pump writes it. */
  async function call(runId: string, key: { tool: string; args: string }, id: string): Promise<void> {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      runId,
      actor: 'slave',
      payload: { name: key.tool, summary: `${key.tool} ${key.args}`, toolUseId: id, argsHash: hashOf(key.args) },
    })
  }

  async function result(runId: string, id: string, outcome: 'ok' | 'error', toolName = 'Bash'): Promise<void> {
    await appendEvent({
      type: 'run.tool_result',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      runId,
      actor: 'slave',
      payload: { toolUseId: id, toolName, outcome, errorClass: outcome === 'error' ? 'timeout' : null },
    })
  }

  async function output(runId: string, text: string): Promise<void> {
    await appendEvent({
      type: 'run.output',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      runId,
      actor: 'slave',
      payload: { text },
    })
  }

  /** A healthy live run: nothing in its window at all. */
  const liveRun = async (over: Parameters<typeof givenBreakerRun>[0] = {}) => givenBreakerRun(over)

  /** A run going in circles: REPEAT_TRIP_COUNT byte-identical calls, each one answered. */
  async function loopingRun(over: Parameters<typeof givenBreakerRun>[0] = {}): Promise<{ id: string }> {
    const run = await givenBreakerRun(over)
    for (let i = 0; i < REPEAT_TRIP_COUNT; i += 1) {
      await call(run.id, { tool: 'Bash', args: 'npm test' }, `toolu_${String(i)}`)
      await result(run.id, `toolu_${String(i)}`, 'ok')
    }
    return run
  }

  /** A run that is neither repeating nor failing, and has said nothing since its last beat. */
  async function quietRun(): Promise<{ id: string }> {
    // A worktree path, because the clock that matters here is the worktree one: a run with NO
    // worktree reads `worktreeChanged: true` without ever consulting the probe (D17).
    const run = await givenBreakerRun({ worktreePath: repoPath })
    await call(run.id, { tool: 'Read', args: 'src/index.ts' }, 'toolu_q')
    await result(run.id, 'toolu_q', 'ok')
    return run
  }

  /** The quiet-long-build shape: one call still outstanding, and nothing else. */
  async function quietRunWithOneOutstandingCall(): Promise<{ id: string }> {
    const run = await givenBreakerRun({ worktreePath: repoPath })
    await call(run.id, { tool: 'Bash', args: 'npm run build' }, 'toolu_build')
    return run
  }

  const reload = async (run: { id: string }) => prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })

  /** Back-date the beat so the next sweep is allowed to beat again, instead of sleeping a minute. */
  const ageTheBeat = async (id: string): Promise<void> => {
    await prisma.slaveRun.update({
      where: { id },
      data: { breakerBeatAt: new Date(Date.now() - BREAKER_BEAT_MS - 1_000) },
    })
  }

  /**
   * The run, back at work after a steer landed: the pump parked it, `deliverBreakerSteers` asked for
   * the resume, the tick claimed it and the child was respawned with the sentence. The CONSTRAIN
   * rung sends a sentence too (spec R3), so the ladder only climbs past it once the run is working
   * again -- a run on its way into a pause is never beaten (fix round 1, Critical 2).
   */
  const asIfSteerDelivered = async (id: string): Promise<void> => {
    await prisma.slaveRun.update({
      where: { id },
      data: { status: 'working', pauseReason: null, queuedMessage: null, resumeRequestedAt: null },
    })
  }

  /** Something changed: a call with a different key, so the trailing repeat run is broken. */
  const makeItBehave = async (id: string): Promise<void> => {
    await call(id, { tool: 'Write', args: 'src/fix.ts' }, 'toolu_new')
    await result(id, 'toolu_new', 'ok', 'Write')
    await output(id, 'I have changed approach.')
  }

  async function eventsOfType(runId: string, type: string): Promise<readonly { payload: unknown }[]> {
    return prisma.executionEvent.findMany({
      where: { runId, type: type as never },
      orderBy: { seq: 'asc' },
      select: { payload: true },
    })
  }

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-sweep-breaker-'))
    dirs.push(repoPath)
    fixture = await seed({ repoPath })
    cancelled = []
    resetTickObservation()
    const adapter = {
      cancel: async (runId: string): Promise<void> => {
        cancelled.push(runId)
      },
    } as unknown as SlaveRuntimeAdapter
    deps = { workspaceId: brandWorkspaceId(fixture.workspaceId), registry: { resolve: () => adapter } }
  })

  afterAll((): void => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing to a healthy run, and stamps the beat so the next tick waits', async (): Promise<void> => {
    const run = await liveRun()
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    const after = await reload(run)
    expect(after.breakerLevel).toBe('none')
    expect(after.breakerBeatAt).not.toBeNull()
  })

  it('beats at most once per BREAKER_BEAT_MS, so a one-second tick loop cannot climb in three', async (): Promise<void> => {
    const run = await loopingRun()
    await sweep(deps)
    await sweep(deps)
    await sweep(deps)
    const after = await reload(run)
    expect(after.breakerLevel).toBe('steered')
    expect(after.breakerTrips).toBe(1)
  })

  it('climbs one rung per beat: steered, then constrained, then stopped', async (): Promise<void> => {
    const run = await loopingRun()
    await sweep(deps)
    expect((await reload(run)).breakerLevel).toBe('steered')
    await ageTheBeat(run.id)
    await sweep(deps)
    const constrained = await reload(run)
    expect(constrained.breakerLevel).toBe('constrained')
    expect(constrained.toolCallCap).toBe(constrained.toolCalls + CONSTRAIN_GRACE_CALLS)
    // The constrain rung told the worker why, which pauses it. The stop rung is reached on a beat
    // after that sentence has been delivered and the run is working again.
    expect(constrained.status).toBe('pause_requested')
    await asIfSteerDelivered(run.id)
    await ageTheBeat(run.id)
    const report = await sweep(deps)
    expect(report.breakerStopped).toEqual([run.id])
    expect((await reload(run)).status).toBe('stopping')
    expect(cancelled).toEqual([run.id])
  })

  it('announces each of the two quiet rungs once, and the loud one as a guardrail', async (): Promise<void> => {
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await sweep(deps)
    const breaker = await eventsOfType(run.id, 'run_breaker')
    expect(breaker.map((row) => (row.payload as { level: string }).level)).toEqual(['steered', 'constrained'])
    expect((breaker[0]?.payload as { trip: string }).trip).toBe('repeated_call')
    await asIfSteerDelivered(run.id)
    await ageTheBeat(run.id)
    await sweep(deps)
    // One rung, one name: the STOP rung writes `guardrail.tripped` and no third `run.breaker`.
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(2)
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    expect((tripped?.payload as { guardrail: string }).guardrail).toBe('behavioural_loop')
  })

  it('writes NO terminal row for a behavioural stop -- the pump concludes it `failed`', async (): Promise<void> => {
    // The laundering bug `pump.ts` spells out: a `stopped` row here is `terminal_uncounted`, so the
    // behavioural stop would never reach the failure streak and the two breakers would not compose.
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await sweep(deps)
    await asIfSteerDelivered(run.id)
    await ageTheBeat(run.id)
    await sweep(deps)
    const after = await reload(run)
    expect(after.status).toBe('stopping')
    expect(after.terminalAt).toBeNull()
    expect(after.endedAt).toBeNull()
  })

  it('steps DOWN one rung on a healthy beat and writes no event at all', async (): Promise<void> => {
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await makeItBehave(run.id)
    await sweep(deps)
    expect((await reload(run)).breakerLevel).toBe('none')
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(1)
  })

  it('leaves a cap it already wrote standing when the level steps back down', async (): Promise<void> => {
    // The design call M51 Task 4 owns: de-escalation lowers the WORD, never the CAP. Clearing it on
    // the way down would make `constrainRun`'s own no-second-refund clause unreachable and turn the
    // thirty-call grace into a refill a wedged run collects every couple of minutes.
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await sweep(deps)
    const cap = (await reload(run)).toolCallCap
    expect(cap).not.toBeNull()
    await asIfSteerDelivered(run.id)
    await ageTheBeat(run.id)
    await makeItBehave(run.id)
    await sweep(deps)
    const after = await reload(run)
    expect(after.breakerLevel).toBe('steered')
    expect(after.toolCallCap).toBe(cap)
  })

  it('honours the run’s OWN cap once one is written, and trips the existing ceiling breach', async (): Promise<void> => {
    const run = await liveRun({ toolCalls: 40, toolCallCap: 30 })
    await sweep(deps)
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    // The existing name, never a new one: the run really is past its tool-call ceiling, and giving
    // the same fact two names is how a filter comes to miss half of it.
    expect((tripped?.payload as { guardrail: string }).guardrail).toBe('tool_call_ceiling')
  })

  it('is checked AFTER the hard limits -- a timed-out looping run is stopped for the timeout', async (): Promise<void> => {
    const run = await loopingRun({ startedAt: hoursAgo(2) })
    const report = await sweep(deps)
    expect(report.timedOut).toEqual([run.id])
    expect(report.breakerStopped).toEqual([])
    expect((await reload(run)).breakerLevel).toBe('none')
  })

  it('never trips while a tool call is still outstanding, however quiet the run is', async (): Promise<void> => {
    const run = await quietRunWithOneOutstandingCall()
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    expect((await reload(run)).breakerLevel).toBe('none')
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(0)
  })

  it('treats an UNREADABLE worktree as evidence of nothing, and does not trip on it', async (): Promise<void> => {
    const run = await quietRun()
    await sweep({ ...deps, worktreeProbe: probeReturning(null) })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning(null) })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning(null) })
    expect((await reload(run)).breakerLevel).toBe('none')
    expect((await reload(run)).breakerQuietBeats).toBe(0)
  })

  it('trips no_progress on the second quiet beat when the worktree really did not move', async (): Promise<void> => {
    // The positive control for the case above: the same run, with a probe that can MEASURE, does
    // trip -- so "a null suppresses" is a real difference and not a test that could never fire.
    const run = await quietRun()
    const probe = { ...deps, worktreeProbe: probeReturning('unchanged') }
    // The first beat has no previous fingerprint to compare with, which is itself no evidence.
    await sweep(probe)
    await ageTheBeat(run.id)
    await sweep(probe)
    expect((await reload(run)).breakerQuietBeats).toBe(1)
    await ageTheBeat(run.id)
    await sweep(probe)
    const after = await reload(run)
    expect(after.breakerLevel).toBe('steered')
    const [breaker] = await eventsOfType(run.id, 'run_breaker')
    expect((breaker?.payload as { trip: string }).trip).toBe('no_progress')
  })

  it('reaches the STOP rung after a relapse, because a re-constrain still writes the rung', async (): Promise<void> => {
    // Fix round 1, Critical 1, through the sweep. The designed path: a run trips, is steered,
    // recovers for one beat, relapses. The second constrain hands out no second grace (D16) and the
    // ladder must still arrive at `stop` rather than re-announcing `constrained` once a minute
    // forever.
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await sweep(deps)
    const cap = (await reload(run)).toolCallCap
    await asIfSteerDelivered(run.id)

    // One healthy beat: the word steps down to `steered`, the cap stands.
    await ageTheBeat(run.id)
    await makeItBehave(run.id)
    await sweep(deps)
    expect((await reload(run)).breakerLevel).toBe('steered')

    // The relapse: the same key again, trailing.
    for (let i = 0; i < REPEAT_TRIP_COUNT; i += 1) {
      await call(run.id, { tool: 'Bash', args: 'npm test' }, `toolu_relapse_${String(i)}`)
      await result(run.id, `toolu_relapse_${String(i)}`, 'ok')
    }
    await ageTheBeat(run.id)
    await sweep(deps)
    const relapsed = await reload(run)
    expect(relapsed.breakerLevel).toBe('constrained')
    // No second grace: the cap is the one the FIRST constrain wrote.
    expect(relapsed.toolCallCap).toBe(cap)

    await asIfSteerDelivered(run.id)
    await ageTheBeat(run.id)
    const report = await sweep(deps)
    expect(report.breakerStopped).toEqual([run.id])
    // One `run.breaker` per escalation and never one per beat: steered, constrained, constrained.
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(3)
  })

  it('never beats a run that is not working, so a steer on its way to the gate survives', async (): Promise<void> => {
    // Fix round 1, Critical 2. `pause_requested` is in SWEEPABLE, so the run `steerRun` just moved
    // there was still beaten -- and one ordinary beat with no trip wrote `deEscalate('steered') =
    // 'none'`, after which `deliverBreakerSteer` refuses it and the queued sentence is stranded on a
    // paused run forever.
    const run = await givenBreakerRun({
      status: 'pause_requested',
      breakerLevel: 'steered',
      breakerTrips: 1,
      breakerSteers: 1,
      pauseReason: 'guardrail',
      queuedMessage: 'stop and rethink',
    })
    await output(run.id, 'still thinking about it')

    await sweep(deps)
    const beaten = await reload(run)
    expect(beaten.breakerLevel).toBe('steered')
    expect(beaten.breakerBeatAt).toBeNull()

    // And the delivery pass still finds it once the pump parks it.
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'paused', pid: null } })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's-1',
        worktreePath: repoPath,
        pauseFlagPath: join(repoPath, 'pause.flag'),
        settingsPath: join(repoPath, 'settings.json'),
        hookPath: join(repoPath, 'pause-gate.sh'),
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'abc123',
      },
    })
    await sweep(deps)
    expect((await reload(run)).resumeRequestedAt).not.toBeNull()
  })

  /**
   * The run a steer parked and never got out of (final wave, I4/E22).
   *
   * `steerRun` claims `pause_requested` and the pause lands at the run's NEXT tool call -- which a
   * `no_progress` run is by definition not making. Without this arm the ladder's own first rung
   * strands the trip that means "the worker has stopped", and only `run_timeout` ever ends it.
   */
  const givenStrandedSteer = async (over: { readonly pausedAgo: number }): Promise<{ id: string }> => {
    const run = await givenBreakerRun({
      status: 'pause_requested',
      breakerLevel: 'steered',
      breakerTrips: 1,
      breakerSteers: 1,
      pauseReason: 'guardrail',
      queuedMessage: 'stop and rethink',
      worktreePath: repoPath,
    })
    await appendEvent({
      type: 'run.pause_requested',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      runId: run.id,
      actor: 'system',
      payload: { requestedBy: 'circuit breaker' },
    })
    await prisma.executionEvent.updateMany({
      where: { runId: run.id, type: 'run_pause_requested' },
      data: { ts: new Date(Date.now() - over.pausedAgo) },
    })
    return run
  }

  it('STOPS a steer that never landed, rather than leaving the ladder stranded', async (): Promise<void> => {
    // The pause was asked for two beats ago and the run has made no tool call since, so the gate it
    // rides on is never going to fire. Through the EXISTING behavioural stop path: claim
    // `stopping`, cancel, `guardrail.tripped` -- and no terminal row, so the pump concludes it
    // `failed` and the failure streak counts it, exactly as every other rung of this ladder does.
    const run = await givenStrandedSteer({ pausedAgo: NO_PROGRESS_BEATS * BREAKER_BEAT_MS + 1_000 })

    const report = await sweep(deps)

    expect(report.breakerStopped).toEqual([run.id])
    const after = await reload(run)
    expect(after.status).toBe('stopping')
    expect(after.terminalAt).toBeNull()
    expect(cancelled).toEqual([run.id])
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    expect((tripped?.payload as { guardrail: string }).guardrail).toBe('behavioural_loop')
    // The trip and its detail, through `stopForBehaviour`'s own unchanged sentence -- one stop path
    // for the whole ladder, so the wording is that path's and not this arm's.
    expect((tripped?.payload as { detail: string }).detail).toContain('no_progress, the pause never landed')
  })

  it('leaves a steered run alone while it is still making tool calls', async (): Promise<void> => {
    // The negative control, and the reason the arm reads the call log at all: a run that is still
    // calling tools is one whose PreToolUse gate is about to fire, so the pause IS landing and the
    // aged timestamp says nothing.
    const run = await givenStrandedSteer({ pausedAgo: NO_PROGRESS_BEATS * BREAKER_BEAT_MS + 1_000 })
    await call(run.id, { tool: 'Bash', args: 'npm test' }, 'toolu_after_pause')

    const report = await sweep(deps)

    expect(report.breakerStopped).toEqual([])
    expect((await reload(run)).status).toBe('pause_requested')
    expect(cancelled).toEqual([])
    expect(await eventsOfType(run.id, 'guardrail_tripped')).toHaveLength(0)
  })

  it('leaves the level exactly as it found it on a SUPPRESSED beat', async (): Promise<void> => {
    // Fix round 1, Important 3. A beat inside a long tool call measures nothing, and the argument
    // that keeps `breakerQuietBeats` still applies verbatim to the rung: a wedged run that happens
    // to be inside one call at each beat would otherwise walk constrained -> steered -> none while
    // measuring nothing at all.
    const run = await givenBreakerRun({ breakerLevel: 'steered', breakerTrips: 1, breakerSteers: 1, worktreePath: repoPath })
    await call(run.id, { tool: 'Bash', args: 'npm run build' }, 'toolu_build')
    await prisma.slaveRun.update({ where: { id: run.id }, data: { breakerQuietBeats: 1 } })

    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    const after = await reload(run)
    expect(after.breakerLevel).toBe('steered')
    // The beat clock still advances, and the quiet count is left alone.
    expect(after.breakerBeatAt).not.toBeNull()
    expect(after.breakerQuietBeats).toBe(1)
  })

  it('names the run’s OWN cap in the ceiling breach, not the workspace’s', async (): Promise<void> => {
    // Fix round 1, Minor 7: the comparison used one number and the sentence printed another, so a
    // constrained run read "past the ceiling of 200" while its real ceiling was 30.
    const run = await liveRun({ toolCalls: 40, toolCallCap: 30 })
    await sweep(deps)
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    expect((tripped?.payload as { detail: string }).detail).toContain('past the ceiling of 30')
  })

  it('delivers a steer on the tick that finds the run actually paused', async (): Promise<void> => {
    const run = await givenBreakerRun({
      status: 'pause_requested',
      pid: null,
      breakerLevel: 'steered',
      breakerTrips: 1,
      breakerSteers: 1,
      pauseReason: 'guardrail',
      queuedMessage: 'stop and rethink',
    })
    await sweep(deps)
    expect((await reload(run)).resumeRequestedAt).toBeNull()
    // What the pump does when the gate denies the next call: the child is dead and the row parks.
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'paused' } })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's-1',
        worktreePath: '/tmp/worktree',
        pauseFlagPath: '/tmp/pause.flag',
        settingsPath: '/tmp/settings.json',
        hookPath: '/tmp/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'abc123',
      },
    })
    await sweep(deps)
    const after = await reload(run)
    expect(after.resumeRequestedAt).not.toBeNull()
    expect(after.queuedMessage).toBe('stop and rethink')
  })
})
