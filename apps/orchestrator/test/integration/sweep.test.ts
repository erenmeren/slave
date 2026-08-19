import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { createPrismaClient, prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import type { AgentRuntimeAdapter } from '@ai-team-os/providers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { reconcileOrphans, sweep, type SweepDeps } from '../../src/sweep.js'

/** A pid that is certainly not running: above the platform maximum for a fresh boot. */
const DEAD_PID = 999_999

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

  const givenRun = async (data: {
    status: 'working' | 'paused' | 'starting' | 'stopping' | 'succeeded'
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
    deps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: {
        cancel: async (runId: string): Promise<void> => {
          cancelled.push(runId)
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
    const restarted = createPrismaClient()

    try {
      expect(await reconcileOrphans({ ...deps, prisma: restarted })).toBe(1)

      // Clearing a workspace halt is the operator's `clear-halt` (Task 16), never automatic: a halt
      // that cleared itself would be a delay, not a halt (§13.1). The fresh client is the point --
      // nothing is carried over in memory, so the column is the only thing that can hold it.
      const workspace = await restarted.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
      expect(workspace.haltedReason).toBe('gate failure')
    } finally {
      await restarted.$disconnect()
    }
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

  it('reports a dead pid found during a sweep without failing it there', async (): Promise<void> => {
    const run = await givenRun({ status: 'working' })

    const report = await sweep(deps)

    // The sweep notices; `reconcileOrphans` is what concludes. Keeping the two apart means the
    // startup pass and the per-tick pass cannot disagree about what a dead pid means.
    expect(report.deadPids).toEqual([run.id])
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('working')
  })
})
