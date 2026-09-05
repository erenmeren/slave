import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
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
})
