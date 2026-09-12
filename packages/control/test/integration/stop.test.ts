import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { recordRunEvidence } from '../../src/evidence.js'
import { isAlive } from '../../src/kill.js'
import { requestStop } from '../../src/stop.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-stop-'))
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id, status: 'working' },
  })
  return { workspace: { id: workspace.id, repoPath }, task: { id: task.id }, run: { id: run.id } }
}

describe('requestStop', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('kills the process, concludes the run, blocks the task, appends run.stopped', async () => {
    const { task, run } = fixture
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
    await new Promise((res) => child.once('spawn', res))
    const pid = child.pid ?? 0
    await prisma.slaveRun.update({ where: { id: run.id }, data: { pid } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: run.id } })

    const result = await requestStop(run.id, 'meren')
    expect(result.ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('stopped')
    expect(after.endedAt).not.toBeNull()
    // The intent record `requestStop` claims before the kill (gate-fix B review round 1): left
    // set after conclusion, as historical record of who asked.
    expect(after.stopRequestedBy).toBe('meren')
    expect(after.stopRequestedAt).not.toBeNull()
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(taskAfter.status).toBe('blocked')
    expect(taskAfter.activeRunId).toBeNull()
    await new Promise((res) => setTimeout(res, 100))
    expect(isAlive(pid)).toBe(false)
  })

  // M41 Task 3b fix round 1. Since a review run claims its task (`review.ts`'s `dispatchReview`,
  // mirroring `startRun`), the guard on this release -- `activeRunId === run.id` -- matches for a
  // review run where it never used to. That is deliberate and it is the right answer: stopping the
  // reviewer parks the task for a human, exactly as stopping an implementation run does. Before the
  // claim, the task stayed `reviewing` with nothing live against it, and the very next tick
  // dispatched a REPLACEMENT reviewer onto the same branch -- an operator's cancel that cancelled
  // nothing and cost another provider run. `unblockTask` is the documented way back.
  it("parks a reviewing task blocked when the run it stops is that task's review run", async () => {
    const { task, run } = fixture
    await prisma.slaveRun.update({ where: { id: run.id }, data: { kind: 'review', pid: 999_999_999 } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'reviewing', activeRunId: run.id } })

    const result = await requestStop(run.id, 'meren')

    expect(result.ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('stopped')
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(taskAfter.status).toBe('blocked')
    expect(taskAfter.activeRunId).toBeNull()
    // No attempt: an operator's cancel is not the reviewer judging the work, and `review.ts`'s own
    // `REVIEW_RETRY_CAP` is what bounds review anyway.
    expect(taskAfter.attempt).toBe(0)
  })

  it('still concludes a run whose process is already gone', async () => {
    const { run } = fixture
    await prisma.slaveRun.update({ where: { id: run.id }, data: { pid: 999_999_999 } })
    const result = await requestStop(run.id, 'meren')
    expect(result.ok).toBe(true)
    const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_stopped' } })
    expect((event?.payload as { reason: string }).reason).toContain('no live process')
  })

  it('does not double-announce a run the daemon pump already concluded stopped first', async () => {
    // The M5 live-gate race, from `requestStop`'s side: the kill wakes another process's pump
    // before this function's own conclusion runs, and the pump's stream-ended path wins the
    // conditioned `updateMany` and appends `run.stopped` itself. This call must still return ok,
    // must still block the task, and must not append a second `run.stopped` for the same stop.
    const { task, run } = fixture
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: run.id } })
    const now = new Date()
    await prisma.slaveRun.update({
      where: { id: run.id },
      data: { pid: 999_999_999, status: 'stopped', terminalAt: now, endedAt: now },
    })
    await appendEvent({
      type: 'run.stopped',
      workspaceId: fixture.workspace.id,
      taskId: task.id,
      slaveId: (await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).slaveId,
      runId: run.id,
      actor: 'system',
      payload: { reason: 'stream ended after a stop was requested' },
    })

    const result = await requestStop(run.id, 'meren')

    expect(result.ok).toBe(true)
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(taskAfter.status).toBe('blocked')
    const events = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_stopped' } })
    expect(events).toHaveLength(1)
  })

  /**
   * M53 R3/R5(b), plan erratum E22 -- the seventh write site.
   *
   * `pump.ts` has an arm that concludes an operator stop too, and it writes the fact when it wins
   * the race. This function usually wins it instead, and before this round the SAME operator action
   * left a row or left nothing depending on which side got there first.
   */
  describe('the fact an operator stop leaves behind (M53 R3, erratum E22)', () => {
    it('writes exactly one row, with the stop counted as a human intervention', async () => {
      const { run } = fixture

      // No pump alive: this function is the only writer of this run's terminal row, which is the
      // common case the pump's own arm cannot cover.
      const result = await requestStop(run.id, 'meren')

      expect(result.ok).toBe(true)
      const rows = await prisma.evidenceRecord.findMany({ where: { runId: run.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe('stopped')
      // R5(b): somebody reached in and stopped this run. `recoveries` stays 0 -- a person is not a
      // recovery, and no sweep concluded anything here.
      expect(rows[0]?.humanInterventions).toBeGreaterThanOrEqual(1)
      expect(rows[0]?.recoveries).toBe(0)
    })

    it('still writes exactly one when the stop is asked for twice', async () => {
      const { run } = fixture
      await requestStop(run.id, 'meren')
      const first = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: run.id } })

      // The second call finds the run already terminal, so `concluded.count` is 0 and this site does
      // not even run -- and if it did, the writer is keyed on `runId` and would upsert onto the row
      // it already wrote. Both halves are asserted, because only one of them is about this site.
      const again = await requestStop(run.id, 'meren')

      expect(again.ok).toBe(true)
      const rows = await prisma.evidenceRecord.findMany({ where: { runId: run.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.recordedAt).toEqual(first.recordedAt)
    })

    it('leaves the PUMP\'s own row alone when the pump won the race', async () => {
      // `concluded.count === 0`: the pump concluded this run and wrote its own fact a moment ago.
      // This function announces nothing and records nothing -- the fact belongs to whoever actually
      // concluded the run, which is the rule all seven sites share.
      const { run } = fixture
      const terminal = new Date()
      await prisma.slaveRun.update({
        where: { id: run.id },
        data: { status: 'stopped', terminalAt: terminal, endedAt: terminal, stopRequestedBy: 'meren' },
      })
      await recordRunEvidence(run.id)
      const pumps = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: run.id } })

      await requestStop(run.id, 'meren')

      const rows = await prisma.evidenceRecord.findMany({ where: { runId: run.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.recordedAt).toEqual(pumps.recordedAt)
    })
  })
})
