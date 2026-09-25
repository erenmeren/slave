import { type ChildProcess, spawn } from 'node:child_process'
import { isAlive } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { BREAKER_BEAT_MS, decide, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { acquireSessionLock } from '@slave-of-ai/events'
import type { SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { childPids, claimAndKillOwnRuns, releaseAbandonedRuns } from '../../src/abandon.js'
import { DAEMON_LOCK_KEY, lockHeldMessage, runDaemon } from '../../src/daemon.js'
import { createRunUnlessArchived, OWNER_INSTANCE, ownerGone } from '../../src/runs.js'
import {
  CLOCK_JUMP_MS,
  noteSweepAt,
  OWNER_GONE_GRACE_MS,
  reconcileOrphans,
  resetTickObservation,
  STOPPING_KILL_GRACE_MS,
  sweep,
  type SweepDeps,
} from '../../src/sweep.js'
import { loadWorld } from '../../src/world.js'

/**
 * H9b R2-R5: every unfinished record has an owner.
 *
 * Each case seeds the exact row shape a gone owner leaves -- a `stopping` run nobody finished
 * stopping (F1), a run whose owning daemon was killed (F2), a merge claim nobody is merging (R5),
 * a run the host slept through (F11b/c) -- and runs the one pass that owns it. The daemon lock (F3)
 * is proved against a real second session, because a lock is only ever a claim about somebody else.
 */

/** A pid that genuinely does not exist: a real child, spawned and reaped (`sweep.test.ts`'s own). */
let DEAD_PID = 0

beforeAll(async (): Promise<void> => {
  const child = spawn('/bin/sh', ['-c', 'exit 0'])
  DEAD_PID = child.pid ?? 0
  await new Promise<void>((res) => child.on('exit', () => res()))
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

/** Live children this file spawned, killed after every case whatever the case did with them. */
const children: ChildProcess[] = []

/** A real, live process standing in for a worker CLI. */
function liveChild(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  children.push(child)
  if (child.pid === undefined) throw new Error('sleep did not spawn')
  return child.pid
}

async function exited(pid: number): Promise<void> {
  for (let i = 0; i < 100 && isAlive(pid); i += 1) await new Promise((res) => setTimeout(res, 20))
}

afterEach((): void => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  vi.restoreAllMocks()
})

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly deps: SweepDeps
  readonly cancelled: string[]
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['true'],
      setupCommands: [],
      runTimeoutMs: 60_000,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Alex' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: person.id },
  })
  const cancelled: string[] = []
  // An adapter that holds no handle for any run -- what a daemon's registry is for a run another
  // process spawned. Its cancel fails the way the real one does.
  const adapter = {
    cancel: async (runId: string): Promise<void> => {
      cancelled.push(runId)
      throw new Error(`no run found for ${runId}`)
    },
  } as unknown as SlaveRuntimeAdapter
  return {
    workspaceId: workspace.id,
    slaveId: slave.id,
    cancelled,
    deps: { workspaceId: brandWorkspaceId(workspace.id), registry: { resolve: () => adapter } },
  }
}

interface RunShape {
  readonly status?: 'starting' | 'working' | 'pause_requested' | 'resuming' | 'stopping' | 'paused'
  readonly kind?: 'implementation' | 'review'
  readonly pid?: number | null
  readonly ownerInstance?: string | null
  readonly stopRequestedBy?: string
  readonly failureClass?: 'worker' | 'platform'
  readonly startedAt?: Date
  readonly pausedMs?: number
  readonly observedWorkingMs?: number
  readonly observedAt?: Date
  readonly taskStatus?: 'running' | 'reviewing'
}

/** A task held by a run of the given shape -- the claim `startRun` / `dispatchReview` leave. */
async function taskHeldBy(fixture: Fixture, shape: RunShape = {}): Promise<{ readonly taskId: string; readonly runId: string }> {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      title: 'Add the thing',
      description: 'make it work',
      status: shape.taskStatus ?? (shape.kind === 'review' ? 'reviewing' : 'running'),
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: fixture.slaveId,
      kind: shape.kind ?? 'implementation',
      status: shape.status ?? 'working',
      pid: shape.pid === undefined ? DEAD_PID : shape.pid,
      ownerInstance: shape.ownerInstance === undefined ? null : shape.ownerInstance,
      ...(shape.stopRequestedBy === undefined ? {} : { stopRequestedBy: shape.stopRequestedBy, stopRequestedAt: new Date() }),
      ...(shape.failureClass === undefined ? {} : { failureClass: shape.failureClass }),
      ...(shape.startedAt === undefined ? {} : { startedAt: shape.startedAt }),
      ...(shape.pausedMs === undefined ? {} : { pausedMs: shape.pausedMs }),
      ...(shape.observedWorkingMs === undefined ? {} : { observedWorkingMs: shape.observedWorkingMs }),
      ...(shape.observedAt === undefined ? {} : { observedAt: shape.observedAt }),
    },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })
  return { taskId: task.id, runId: run.id }
}

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000)

/** Runs `pass` with `Date.now()` moved `ms` into the future -- a grace measured in this process. */
async function later<T>(ms: number, pass: () => Promise<T>): Promise<T> {
  const real = Date.now.bind(Date)
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + ms)
  try {
    return await pass()
  } finally {
    spy.mockRestore()
  }
}

/** An owner token for a process that is gone: a pid that exists no more. */
const goneOwner = (): string => `${String(DEAD_PID)}/00000000-0000-4000-8000-000000000000`

describe('every unfinished record has an owner (H9b)', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "EvidenceRecord", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    resetTickObservation()
    fixture = await seed()
  })

  describe('a stopping run is owned by every sweep (R2, F1)', () => {
    it("concludes an operator's stop whose process is gone as stopped, and blocks its task", async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping', stopRequestedBy: 'web' })

      const report = await sweep(fixture.deps)

      expect(report.stoppingConcluded).toEqual([runId])
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'stopped',
        failureClass: null,
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'blocked',
        activeRunId: null,
        attempt: 0,
      })
      const stopped = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'run_stopped' } })
      expect(JSON.stringify(stopped.payload)).toContain('cancelled by web')
    })

    it("concludes a guardrail's stop whose process is gone as failed, charging the worker", async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping' })

      const report = await sweep(fixture.deps)

      expect(report.stoppingConcluded).toEqual([runId])
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'failed' })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'rework',
        activeRunId: null,
        attempt: 1,
      })
      expect(await prisma.executionEvent.count({ where: { runId, type: 'run_failed' } })).toBe(1)
      // No second announcement of the cancel: the claim already made it.
      expect(await prisma.executionEvent.count({ where: { runId, type: 'guardrail_tripped' } })).toBe(0)
    })

    it('keeps the class the claim wrote -- a timeout after a clock jump gives the attempt back', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping', failureClass: 'platform' })

      await sweep(fixture.deps)

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 0 })
    })

    it("gives a stopping review run's task its claim back and nothing else", async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping', kind: 'review' })

      await sweep(fixture.deps)

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('failed')
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'reviewing',
        activeRunId: null,
        attempt: 0,
      })
    })

    it('leaves a stopping run to the pump that is concluding it in this process', async (): Promise<void> => {
      const { runId } = await taskHeldBy(fixture, { status: 'stopping' })

      const report = await sweep({ ...fixture.deps, livePumpRunIds: new Set([runId]) })

      expect(report.stoppingConcluded).toEqual([])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('stopping')
    })

    it('kills a stopping run whose process outlives the grace, and concludes it once it is gone', async (): Promise<void> => {
      const pid = liveChild()
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping', pid })

      // The first pass only starts the clock: a cancel may still be landing.
      expect((await sweep(fixture.deps)).stoppingKilled).toEqual([])
      expect(isAlive(pid)).toBe(true)

      const killed = await later(STOPPING_KILL_GRACE_MS + 1_000, () => sweep(fixture.deps))
      expect(killed.stoppingKilled).toEqual([runId])
      await exited(pid)
      expect(isAlive(pid)).toBe(false)

      const concluded = await sweep(fixture.deps)
      expect(concluded.stoppingConcluded).toEqual([runId])
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
    })

    it('concludes a stopping run the orphan pass finds at startup the way its cancel meant', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'stopping', stopRequestedBy: 'cli' })

      expect(await reconcileOrphans(fixture.deps)).toBe(1)

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('stopped')
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('blocked')
    })

    it("kills a guardrail's run by pid when the adapter's cancel fails", async (): Promise<void> => {
      // The 2026-09-21 shape: the run was spawned by another daemon, so this one's adapter has no
      // handle and its cancel says "no run found". The pid on the row is what is left.
      const pid = liveChild()
      const { runId } = await taskHeldBy(fixture, {
        pid,
        startedAt: minutesAgo(5),
        observedWorkingMs: 120_000,
        observedAt: new Date(Date.now() - 1_000),
      })

      const report = await sweep(fixture.deps)

      expect(report.timedOut).toEqual([runId])
      expect(fixture.cancelled).toEqual([runId])
      await exited(pid)
      expect(isAlive(pid)).toBe(false)
      const tripped = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'guardrail_tripped' } })
      expect(JSON.stringify(tripped.payload)).toContain('killed by pid')

      // And the next pass concludes it: nothing is left `stopping`.
      expect((await sweep(fixture.deps)).stoppingConcluded).toEqual([runId])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('failed')
    })
  })

  describe('a run whose owner is gone (R3, F2)', () => {
    it('kills its live child after the grace and concludes it as a platform failure', async (): Promise<void> => {
      const pid = liveChild()
      const { taskId, runId } = await taskHeldBy(fixture, { pid, ownerInstance: goneOwner() })

      expect((await sweep(fixture.deps)).ownerGone).toEqual([])
      expect(isAlive(pid)).toBe(true)

      const report = await later(OWNER_GONE_GRACE_MS + 1_000, () => sweep(fixture.deps))

      expect(report.ownerGone).toEqual([runId])
      await exited(pid)
      expect(isAlive(pid)).toBe(false)
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'rework',
        activeRunId: null,
        attempt: 0,
      })
    })

    it('reads a token with THIS pid but another uuid as a predecessor that is gone', async (): Promise<void> => {
      // A container restart: the new daemon has the old one's pid.
      expect(ownerGone(`${String(process.pid)}/11111111-1111-4111-8111-111111111111`)).toBe(true)
      expect(ownerGone(OWNER_INSTANCE)).toBe(false)
    })

    it('leaves a run alone whose owner is this process, a live other process, or unrecorded', async (): Promise<void> => {
      const pid = liveChild()
      const otherOwner = liveChild()
      const mine = await taskHeldBy(fixture, { pid, ownerInstance: OWNER_INSTANCE })
      const theirs = await taskHeldBy(fixture, { pid, ownerInstance: `${String(otherOwner)}/22222222-2222-4222-8222-222222222222` })
      const legacy = await taskHeldBy(fixture, { pid, ownerInstance: null })

      const report = await later(OWNER_GONE_GRACE_MS + 1_000, async () => {
        await sweep(fixture.deps)
        return later(2 * OWNER_GONE_GRACE_MS, () => sweep(fixture.deps))
      })

      expect(report.ownerGone).toEqual([])
      for (const { runId } of [mine, theirs, legacy]) {
        expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('working')
      }
      expect(isAlive(pid)).toBe(true)
    })

    it('concludes a run whose owner died before it ever spawned', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'starting', pid: null, ownerInstance: goneOwner() })

      await sweep(fixture.deps)
      const report = await later(OWNER_GONE_GRACE_MS + 1_000, () => sweep(fixture.deps))

      expect(report.ownerGone).toEqual([runId])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).failureClass).toBe('platform')
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
    })

    it('names this process as the owner of every run it inserts', async (): Promise<void> => {
      const created = await createRunUnlessArchived(fixture.workspaceId, { slaveId: fixture.slaveId, kind: 'planning' })
      expect(created).not.toBeNull()
      const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: created?.id ?? '' } })
      expect(row.ownerInstance).toBe(OWNER_INSTANCE)
    })

    it('on a forced stop, ends its own runs as platform failures before killing their children', async (): Promise<void> => {
      const pid = liveChild()
      const { taskId, runId } = await taskHeldBy(fixture, { pid, ownerInstance: OWNER_INSTANCE })

      expect(childPids()).toContain(pid)
      const claimed = await claimAndKillOwnRuns([runId])
      // What the pump writes a moment later, when the killed child's stream ends: conditioned on
      // the run not having concluded, so it matches nothing -- the worker is not charged.
      const pumpWrite = await prisma.slaveRun.updateMany({
        where: { id: runId, endedAt: null },
        data: { status: 'failed', failureClass: 'worker' },
      })
      await releaseAbandonedRuns(claimed)

      expect(claimed.map((run) => run.id)).toEqual([runId])
      expect(pumpWrite.count).toBe(0)
      await exited(pid)
      expect(isAlive(pid)).toBe(false)
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 0 })
      expect(await prisma.executionEvent.count({ where: { runId, type: 'run_failed' } })).toBe(1)
    })
  })

  describe('one daemon per database (R4, F3)', () => {
    const url = (): string => {
      const value = process.env['DATABASE_URL']
      if (value === undefined) throw new Error('DATABASE_URL is not set for the integration suite')
      return value
    }

    it('refuses a second holder while the first holds the lock, and admits one once it is gone', async (): Promise<void> => {
      const first = await acquireSessionLock(url(), DAEMON_LOCK_KEY)
      expect(first).not.toBeNull()
      expect(await acquireSessionLock(url(), DAEMON_LOCK_KEY, { waitMs: 300 })).toBeNull()

      await first?.release()
      const second = await acquireSessionLock(url(), DAEMON_LOCK_KEY, { waitMs: 300 })
      expect(second).not.toBeNull()
      await second?.release()
    })

    it('frees the lock when the holding session simply ends, the way a killed daemon ends', async (): Promise<void> => {
      const holder = new Client({ connectionString: url() })
      await holder.connect()
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [DAEMON_LOCK_KEY.toString()])
      expect(await acquireSessionLock(url(), DAEMON_LOCK_KEY, { waitMs: 300 })).toBeNull()

      await holder.end()
      const next = await acquireSessionLock(url(), DAEMON_LOCK_KEY, { waitMs: 3_000 })
      expect(next).not.toBeNull()
      await next?.release()
    })

    it('refuses to start a daemon while another holds the lock, before serving anything', async (): Promise<void> => {
      const other = await acquireSessionLock(url(), DAEMON_LOCK_KEY)
      try {
        await expect(
          runDaemon({ workspaceIds: 'all', registry: fixture.deps.registry, periodMs: 200, until: Promise.resolve() }),
        ).rejects.toThrow(lockHeldMessage())
      } finally {
        await other?.release()
      }
    }, 20_000)
  })

  describe('the run timeout measures observed working time (F11b)', () => {
    it('adds at most one beat for a gap the sweep did not see, however long', async (): Promise<void> => {
      // The 2026-09-22 shape: started sixteen hours ago, last seen sixteen hours ago, a
      // one-minute limit -- and the host was asleep for all of it.
      const { runId } = await taskHeldBy(fixture, {
        pid: process.pid,
        startedAt: minutesAgo(16 * 60),
        observedWorkingMs: 0,
        observedAt: minutesAgo(16 * 60),
      })
      noteSweepAt(fixture.deps.workspaceId, Date.now() - CLOCK_JUMP_MS - 60_000)

      const report = await sweep(fixture.deps)

      expect(report.timedOut).toEqual([])
      const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
      expect(row.status).toBe('working')
      expect(row.observedWorkingMs).toBe(BREAKER_BEAT_MS)
    })

    it('keeps what it observed across a restart rather than starting the run over', async (): Promise<void> => {
      const { runId } = await taskHeldBy(fixture, {
        pid: process.pid,
        startedAt: minutesAgo(10),
        observedWorkingMs: 50_000,
        observedAt: new Date(Date.now() - 2_000),
      })

      await sweep(fixture.deps)
      const first = (await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).observedWorkingMs
      expect(first).toBeGreaterThanOrEqual(52_000)
      expect(first).toBeLessThan(55_000)

      // A new daemon: nothing in memory, the column is all it has.
      resetTickObservation()
      const report = await later(9_000, () => sweep(fixture.deps))
      expect(report.timedOut).toEqual([runId])
    })

    it('never counts time the run sat paused', async (): Promise<void> => {
      // Ten minutes on the clock, nine and a half of them paused, last seen before the pause: the
      // gap is capped at one beat, and the working time (thirty seconds) caps it again.
      const { runId } = await taskHeldBy(fixture, {
        pid: process.pid,
        startedAt: minutesAgo(10),
        pausedMs: 9.5 * 60_000,
        observedWorkingMs: 0,
        observedAt: minutesAgo(10),
      })

      await sweep(fixture.deps)

      const observed = (await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).observedWorkingMs
      expect(observed).toBeGreaterThanOrEqual(29_000)
      expect(observed).toBeLessThanOrEqual(31_000)
    })
  })

  describe('on wake after a clock jump (F11c)', () => {
    it('retries at once a run whose child died with the sleep, and leaves a live one alone', async (): Promise<void> => {
      const dead = await taskHeldBy(fixture, { pid: DEAD_PID, startedAt: minutesAgo(16 * 60) })
      const survivor = await taskHeldBy(fixture, {
        pid: process.pid,
        startedAt: minutesAgo(16 * 60),
        // Short of its one-minute limit by more than the beat the wake adds.
        observedWorkingMs: 0,
        observedAt: minutesAgo(16 * 60),
      })
      noteSweepAt(fixture.deps.workspaceId, Date.now() - CLOCK_JUMP_MS - 60 * 60_000)

      const report = await sweep(fixture.deps)

      expect(report.deadPids).toEqual([dead.runId])
      expect(report.timedOut).toEqual([])
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: dead.runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
        providerError: false,
      })
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: survivor.runId } })).status).toBe('working')

      // At once: no backoff, no attempt spent, no breaker -- the next decision starts it again on the
      // seat the survivor is not holding.
      await prisma.slaveRun.update({ where: { id: survivor.runId }, data: { status: 'succeeded', endedAt: new Date(), terminalAt: new Date() } })
      await prisma.task.update({ where: { id: survivor.taskId }, data: { status: 'done', activeRunId: null } })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: dead.taskId } })).toMatchObject({ status: 'rework', attempt: 0 })
      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(decide(world)).toEqual([{ kind: 'start_run', taskId: dead.taskId, slaveId: fixture.slaveId }])
    })
  })

  describe('the rest of the owner table (R5)', () => {
    it('concludes a pause_requested run whose process died before the pause landed', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'pause_requested' })

      const report = await sweep(fixture.deps)

      expect(report.deadPids).toEqual([runId])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).failureClass).toBe('platform')
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 0 })
    })

    it('concludes a resuming run a previous daemon left with a dead pid, at startup', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { status: 'resuming' })

      expect(await reconcileOrphans(fixture.deps)).toBe(1)

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
    })

    it('leaves a paused review run to the passes that resume it', async (): Promise<void> => {
      const { runId } = await taskHeldBy(fixture, { status: 'paused', kind: 'review', pid: null })

      await sweep(fixture.deps)
      resetTickObservation()
      await reconcileOrphans(fixture.deps)

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('paused')
    })

    it('releases a merge claim nobody is merging once it outlives every merge the workspace allows', async (): Promise<void> => {
      const stale = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Merged by a process that died',
          description: 'x',
          status: 'merging',
          maxAttempts: 3,
          mergeClaimedAt: minutesAgo(10),
        },
      })
      const fresh = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Being merged right now',
          description: 'x',
          status: 'merging',
          maxAttempts: 3,
          mergeClaimedAt: new Date(),
        },
      })

      const report = await sweep(fixture.deps)

      expect(report.staleMerges).toEqual([stale.id])
      expect(await prisma.task.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
        status: 'rework',
        mergeClaimedAt: null,
        lastRejectionReason: 'merge interrupted',
        attempt: 0,
      })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('merging')
      expect(await prisma.executionEvent.count({ where: { taskId: stale.id, type: 'task_merge_failed' } })).toBe(1)
    })
  })
})
