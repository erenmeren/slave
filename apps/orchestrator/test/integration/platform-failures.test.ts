import { spawn } from 'node:child_process'
import { workspaceStats } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  decide,
  PROVIDER_ERROR_BACKOFF_MS,
  runId as brandRunId,
  slaveId as brandSlaveId,
  taskId as brandTaskId,
  workspaceId as brandWorkspaceId,
} from '@slave-of-ai/domain'
import type { RunOutcome, RuntimeEvent, SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pumpRun } from '../../src/pump.js'
import { CLOCK_JUMP_MS, noteSweepAt, reconcileOrphans, resetTickObservation, sweep, type SweepDeps } from '../../src/sweep.js'
import { verifyConcludedRun } from '../../src/verify.js'
import { loadWorld } from '../../src/world.js'

/**
 * H9b R1: a PLATFORM failure is not a worker failure.
 *
 * Each case seeds the exact row shape one of the four platform failures leaves -- an orphan a
 * restarted daemon reconciles (F4), a run whose pid died under a live daemon, a provider
 * `api_error` (F5), a timeout decided after the host slept (F11a) -- and runs the one pass that
 * classifies it. What they share is the promise the column exists to keep: no breaker rung, the
 * task's attempt given back, and, for a refusal alone, a wait before the retry.
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

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly deps: SweepDeps
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
  const adapter = { cancel: async (): Promise<void> => {} } as unknown as SlaveRuntimeAdapter
  return {
    workspaceId: workspace.id,
    slaveId: slave.id,
    deps: {
      workspaceId: brandWorkspaceId(workspace.id),
      registry: { resolve: () => adapter },
    },
  }
}

/** A task held by a live run of its own, the shape `startRun` leaves: `running`, claimed. */
async function taskHeldBy(
  fixture: Fixture,
  run: { readonly pid?: number | null; readonly startedAt?: Date; readonly status?: 'working' | 'starting' } = {},
): Promise<{ readonly taskId: string; readonly runId: string }> {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      title: 'Add the thing',
      description: 'make it work',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const row = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: fixture.slaveId,
      status: run.status ?? 'working',
      pid: run.pid === undefined ? DEAD_PID : run.pid,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: row.id } })
  return { taskId: task.id, runId: row.id }
}

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000)

describe('platform failures (H9b R1)', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    resetTickObservation()
    fixture = await seed()
  })

  describe('orphan reconciliation (F4)', () => {
    it('concludes an orphan as a platform failure, charging no attempt', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture)

      expect(await reconcileOrphans(fixture.deps)).toBe(1)

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
        providerError: false,
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'rework',
        attempt: 0,
        activeRunId: null,
      })
    })

    it('does not trip the breaker on three orphans in a row, where three worker failures do', async (): Promise<void> => {
      // The restart-chaos gate's shape: three daemon kills, each landing on a live run.
      for (let kill = 0; kill < 3; kill += 1) {
        await taskHeldBy(fixture)
        resetTickObservation()
        await reconcileOrphans(fixture.deps)
      }
      const orphaned = await workspaceStats(fixture.workspaceId)
      expect(orphaned.stats.consecutiveFailures).toBe(0)
      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(decide(world).some((command) => command.kind === 'halt')).toBe(false)

      // The control: the same three rows as the WORKER's failures are a streak, and it halts.
      await prisma.slaveRun.updateMany({ data: { failureClass: 'worker' } })
      const counted = await workspaceStats(fixture.workspaceId)
      expect(counted.stats.consecutiveFailures).toBe(3)
      const again = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(decide(again.world)).toEqual([{ kind: 'halt', reason: 'circuit_breaker' }])
    })

    it('leaves a platform failure out of the streak rather than reading it as a break', async (): Promise<void> => {
      // worker, platform, worker, worker -- newest last. Three real failures with a crash between
      // them are still three real failures in a row.
      const kinds = ['worker', 'platform', 'worker', 'worker'] as const
      for (const [index, failureClass] of kinds.entries()) {
        const at = minutesAgo(10 - index)
        await prisma.slaveRun.create({
          data: { slaveId: fixture.slaveId, status: 'failed', startedAt: at, terminalAt: at, failureClass },
        })
      }
      expect((await workspaceStats(fixture.workspaceId)).stats.consecutiveFailures).toBe(3)
    })

    it('still counts a failed row written before the column existed, which has no class', async (): Promise<void> => {
      for (let index = 0; index < 3; index += 1) {
        const at = minutesAgo(10 - index)
        await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, status: 'failed', startedAt: at, terminalAt: at } })
      }
      expect((await workspaceStats(fixture.workspaceId)).stats.consecutiveFailures).toBe(3)
    })

    it('concludes a dead pid found by the per-tick sweep as a platform failure too', async (): Promise<void> => {
      const { runId } = await taskHeldBy(fixture)

      const report = await sweep(fixture.deps)

      expect(report.deadPids).toEqual([runId])
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
    })
  })

  describe('a timeout decided after a clock jump (F11a)', () => {
    /**
     * A run whose process is alive -- this test process's own pid -- and a second short of its limit
     * when the sweep last saw it, sixteen hours ago. The timeout reads OBSERVED working time since
     * H9b (F11b), so a sleep alone can no longer time a run out: what is left of F11a is the run the
     * sleep caught just short of its limit, whose next beat carries it over on the pass that wakes.
     */
    const overdue = async (): Promise<{ readonly taskId: string; readonly runId: string }> => {
      const held = await taskHeldBy(fixture, { pid: process.pid, startedAt: minutesAgo(16 * 60) })
      await prisma.slaveRun.update({
        where: { id: held.runId },
        data: { observedWorkingMs: 59_000, observedAt: minutesAgo(16 * 60 - 1) },
      })
      return held
    }

    it('marks the timeout platform when the previous pass was more than five beats ago', async (): Promise<void> => {
      const { runId } = await overdue()
      // The host slept: this process last swept the workspace an hour ago.
      noteSweepAt(fixture.deps.workspaceId, Date.now() - CLOCK_JUMP_MS - 60_000)

      const report = await sweep(fixture.deps)

      expect(report.timedOut).toEqual([runId])
      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'stopping',
        failureClass: 'platform',
      })
      const tripped = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'guardrail_tripped' } })
      expect(JSON.stringify(tripped.payload)).toContain('clock jump')
    })

    it('leaves the class alone on an ordinary pass, and on the first pass of a process', async (): Promise<void> => {
      const { runId } = await overdue()
      // The first pass this process makes has nothing to measure from: a daemon that restarts
      // after a long gap finds orphans, which are `reconcileOrphans`' platform failures.
      await sweep(fixture.deps)
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).failureClass).toBeNull()

      const second = await overdue()
      noteSweepAt(fixture.deps.workspaceId, Date.now() - 1_000)
      await sweep(fixture.deps)
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: second.runId } })).failureClass).toBeNull()
    })

    it('gives the attempt back once the pump concludes the cancelled run', async (): Promise<void> => {
      const { taskId, runId } = await overdue()
      noteSweepAt(fixture.deps.workspaceId, Date.now() - CLOCK_JUMP_MS - 60_000)
      await sweep(fixture.deps)

      // What the pump does next: the killed child's stream ends with no terminal result.
      await pumpRun({
        runId: brandRunId(runId),
        taskId: brandTaskId(taskId),
        slaveId: brandSlaveId(fixture.slaveId),
        workspaceId: brandWorkspaceId(fixture.workspaceId),
        cancel: async (): Promise<void> => {},
        events: (async function* (): AsyncIterable<RuntimeEvent> {})(),
      })
      await verifyConcludedRun(brandRunId(runId))

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 0 })
    })
  })

  describe('a provider refusal (F5)', () => {
    const refused: RunOutcome = {
      isError: true,
      terminalReason: 'api_error',
      errorText: 'API Error: 429 rate limited',
      stopReason: null,
      numTurns: 1,
      costUsd: 0,
      deniedToolUseIds: [],
      tokens: null,
    }

    async function pumpRefusal(taskId: string, runId: string, outcome: RunOutcome = refused): Promise<void> {
      await pumpRun({
        runId: brandRunId(runId),
        taskId: brandTaskId(taskId),
        slaveId: brandSlaveId(fixture.slaveId),
        workspaceId: brandWorkspaceId(fixture.workspaceId),
        cancel: async (): Promise<void> => {},
        events: (async function* (): AsyncIterable<RuntimeEvent> {
          yield { kind: 'session_started', sessionId: 's-1' }
          yield { kind: 'terminated', outcome }
        })(),
      })
      await verifyConcludedRun(brandRunId(runId))
    }

    it('concludes the run as a platform failure, gives the attempt back and holds the task back', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { pid: null, status: 'starting' })

      await pumpRefusal(taskId, runId)

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'platform',
        providerError: true,
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 0 })

      // Rework, a free seat, no halt -- and still nothing starts, because the refusal is sixty
      // seconds old at most.
      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(world.tasks.find((task) => task.id === taskId)?.backingOff).toBe(true)
      expect(decide(world)).toEqual([])
    })

    it('lets the task go once the backoff has run out', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { pid: null, status: 'starting' })
      await pumpRefusal(taskId, runId)
      const past = new Date(Date.now() - PROVIDER_ERROR_BACKOFF_MS - 1_000)
      await prisma.slaveRun.update({ where: { id: runId }, data: { terminalAt: past, startedAt: past } })

      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(decide(world)).toEqual([{ kind: 'start_run', taskId, slaveId: fixture.slaveId }])
    })

    it('doubles the wait for a second refusal in a row', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { pid: null, status: 'starting' })
      // An older refusal, then a fresh one 90 s ago: one refusal would have let the task go at 60 s,
      // two in a row hold it for 120 s.
      await prisma.slaveRun.create({
        data: {
          taskId,
          slaveId: fixture.slaveId,
          status: 'failed',
          failureClass: 'platform',
          providerError: true,
          startedAt: minutesAgo(5),
          terminalAt: minutesAgo(5),
        },
      })
      await pumpRefusal(taskId, runId)
      const ninetySecondsAgo = new Date(Date.now() - 90_000)
      await prisma.slaveRun.update({ where: { id: runId }, data: { terminalAt: ninetySecondsAgo, startedAt: ninetySecondsAgo } })

      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(world.tasks.find((task) => task.id === taskId)?.backingOff).toBe(true)
    })

    it('does not count three refusals in a row toward the breaker', async (): Promise<void> => {
      for (let refusal = 0; refusal < 3; refusal += 1) {
        const { taskId, runId } = await taskHeldBy(fixture, { pid: null, status: 'starting' })
        await pumpRefusal(taskId, runId)
      }
      expect((await workspaceStats(fixture.workspaceId)).stats.consecutiveFailures).toBe(0)
    })

    it('still charges the worker for an error that is not the provider refusing', async (): Promise<void> => {
      const { taskId, runId } = await taskHeldBy(fixture, { pid: null, status: 'starting' })

      await pumpRefusal(taskId, runId, { ...refused, terminalReason: 'error_during_execution', errorText: 'the tests failed' })

      expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: 'failed',
        failureClass: 'worker',
        providerError: false,
      })
      expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'rework', attempt: 1 })
      const { world } = await loadWorld(brandWorkspaceId(fixture.workspaceId))
      expect(world.tasks.find((task) => task.id === taskId)?.backingOff).toBeUndefined()
    })
  })
})
