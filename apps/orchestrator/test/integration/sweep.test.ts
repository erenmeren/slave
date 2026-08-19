import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import type { AgentRuntimeAdapter } from '@ai-team-os/providers'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  readonly agentId: string
}

const dirs: string[] = []

async function seed(overrides: { readonly runTimeoutMs?: number } = {}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['true'],
      setupCommands: [],
      maxToolCallsPerRun: 200,
      ...(overrides.runTimeoutMs === undefined ? {} : { runTimeoutMs: overrides.runTimeoutMs }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, taskId: task.id, agentId: agent.id }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

const hoursAgo = (n: number): Date => new Date(Date.now() - n * 60 * 60 * 1000)

describe('sweep and reconcileOrphans', () => {
  let fixture: Fixture
  let deps: SweepDeps
  let cancelled: string[]
  let cancelThrows: boolean
  let concludeDuringCancel: boolean

  const givenRun = async (data: {
    status: 'working' | 'paused' | 'starting' | 'stopping' | 'succeeded' | 'pause_requested' | 'resuming'
    pid?: number | null
    toolCalls?: number
    startedAt?: Date
    worktreePath?: string
    taskId?: string
  }) =>
    prisma.agentRun.create({
      data: {
        taskId: data.taskId ?? fixture.taskId,
        agentId: fixture.agentId,
        status: data.status,
        pid: data.pid === undefined ? DEAD_PID : data.pid,
        toolCalls: data.toolCalls ?? 0,
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        ...(data.worktreePath === undefined ? {} : { worktreePath: data.worktreePath }),
      },
    })

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    cancelled = []
    cancelThrows = false
    concludeDuringCancel = false
    resetTickObservation()
    deps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: {
        cancel: async (runId: string): Promise<void> => {
          cancelled.push(runId)
          // The real `cancel` awaits the child's exit, which is exactly the window in which the
          // pump writes the terminal row. Modelling that here is what makes the lost-update
          // observable from a test.
          if (concludeDuringCancel) {
            await prisma.agentRun.update({
              where: { id: runId },
              data: { status: 'succeeded', terminalAt: new Date(), costUsd: 1.5 },
            })
          }
          if (cancelThrows) throw new Error('SIGTERM failed: process not registered')
        },
      } as unknown as AgentRuntimeAdapter,
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
    const run = await prisma.agentRun.findFirstOrThrow()
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
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('failed')
  })

  it('preserves the worktree of an orphaned run', async (): Promise<void> => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'aiteamos-sweep-'))
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

  it('leaves a paused run alone: it legitimately has no process', async (): Promise<void> => {
    await givenRun({ status: 'paused' })

    const count = await reconcileOrphans(deps)

    // A paused run's process was killed by the adapter on purpose -- that is what pausing *is*
    // (Task 8) -- so it presents with a dead pid and a non-terminal status, which is precisely the
    // orphan shape. Discriminating on liveness alone destroys every paused run in the fleet on the
    // first daemon restart, along with the checkpoint written to preserve it.
    expect(count).toBe(0)
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('paused')
  })

  it("leaves another workspace's runs alone", async (): Promise<void> => {
    const other = await seed()
    await prisma.agentRun.create({
      data: { taskId: other.taskId, agentId: other.agentId, status: 'working', pid: DEAD_PID },
    })

    expect(await reconcileOrphans(deps)).toBe(0)
    const run = await prisma.agentRun.findFirstOrThrow()
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

    expect(report).toEqual({ timedOut: [], overToolCap: [], deadPids: [] })
    expect(cancelled).toEqual([])
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('concludes a run whose process is gone, as §3.3 requires', async (): Promise<void> => {
    const run = await givenRun({ status: 'working' })

    const report = await sweep(deps)

    // §3.3: "Dead pid -> the process is gone but the run is not terminal. Mark it failed, preserve
    // the worktree, emit run.failed." Only reporting it leaves no in-process path by which any run
    // is ever concluded: a run whose pump died, or whose process was killed externally, would stay
    // non-terminal with its agent busy and its task stranded until the next daemon restart, while
    // the sweep watched it every second and did nothing.
    expect(report.deadPids).toEqual([run.id])
    const row = await prisma.agentRun.findFirstOrThrow()
    expect(row.status).toBe('failed')
    expect(row.terminalAt).not.toBeNull()
    expect(row.endedAt).not.toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['run.failed'])
  })

  it('leaves a run that has not yet recorded its pid alone', async (): Promise<void> => {
    await givenRun({ status: 'starting', pid: null })

    const report = await sweep(deps)

    // The one shape the sweep must not act on: Task 13 creates the row and records the pid a moment
    // later, so a null pid mid-tick is a run about to spawn, not a dead one. Discriminating on the
    // pid rather than on liveness is what keeps §3.3 implementable from inside a running daemon.
    expect(report.deadPids).toEqual([])
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('starting')
  })

  it('does not resurrect a run the pump concluded while the cancel was in flight', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })
    // `cancel` awaits the child's exit, so by the time it returns the pump has very plausibly
    // already written the terminal row -- and a run at its wall-clock limit is exactly the kind
    // that is about to finish. An unguarded status write then rewrites `succeeded` back to
    // `stopping`: the agent reads busy forever, the task is never released, and the failure streak
    // never sees a run that actually concluded.
    concludeDuringCancel = true

    const report = await sweep(deps)

    // The conclusion lands *during* the cancel, so a cancel genuinely was issued and the report and
    // the event are honest about it. What must not survive is the status write: an unguarded one
    // rewrites `succeeded` back to `stopping` after the fact.
    const row = await prisma.agentRun.findFirstOrThrow()
    expect(row.status).toBe('succeeded')
    expect(row.terminalAt).not.toBeNull()
    expect(report.timedOut).toEqual([run.id])
  })

  it('does nothing to a run the pump concluded before the sweep looked', async (): Promise<void> => {
    await givenRun({ status: 'succeeded', pid: process.pid, startedAt: hoursAgo(2) })

    const report = await sweep(deps)

    // The other half of the same race: a run already terminal is not swept at all, so no cancel is
    // issued and nothing announces one.
    expect(report).toEqual({ timedOut: [], overToolCap: [], deadPids: [] })
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
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('failed')
  })

  it('names the guardrail for the limit that was actually breached', async (): Promise<void> => {
    await givenRun({ status: 'working', pid: process.pid, toolCalls: 500 })

    await sweep(deps)

    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect((event.payload as { guardrail: string }).guardrail).toBe('tool_call_ceiling')
  })

  it('correlates its events to the run, task and agent they are about', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })

    await sweep(deps)

    // Correlation is what M4 renders from: an event with a null runId is an event about nothing.
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(event.runId).toBe(run.id)
    expect(event.taskId).toBe(fixture.taskId)
    expect(event.agentId).toBe(fixture.agentId)
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

    expect(report).toEqual({ timedOut: [], overToolCap: [], deadPids: [] })
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
    // would hand the same task to a second agent while the first is still going -- the hazard Task
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
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('working')
  })

  it('treats pid 0 as dead rather than as the whole process group', async (): Promise<void> => {
    // `kill(0, 0)` signals the caller's own process group and always succeeds, so a run recorded
    // with pid 0 would read as alive forever and never be reconcilable.
    await givenRun({ status: 'working', pid: 0 })

    expect(await reconcileOrphans(deps)).toBe(1)
  })

  it("leaves another workspace's runs out of the sweep too", async (): Promise<void> => {
    const other = await seed()
    await prisma.agentRun.create({
      data: {
        taskId: other.taskId,
        agentId: other.agentId,
        status: 'working',
        pid: process.pid,
        toolCalls: 500,
      },
    })

    const report = await sweep(deps)

    expect(report).toEqual({ timedOut: [], overToolCap: [], deadPids: [] })
    expect(cancelled).toEqual([])
  })

  it('leaves a task alone when the sweep concludes an older run of it', async (): Promise<void> => {
    await givenRun({ status: 'working' })
    const replacement = await givenRun({ status: 'working', pid: process.pid })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: replacement.id } })

    await sweep(deps)

    // The same guard the orphan pass needs, on the path that runs every second rather than once at
    // startup: releasing a task because an older run died hands it to a second agent while the
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
    // worktree with a second agent. Documented-only, that failure is silent.
    await expect(reconcileOrphans(deps)).rejects.toThrow(/startup/i)
  })

})
