import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { isAlive } from '../../src/kill.js'
import { requestStop } from '../../src/stop.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-stop-'))
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'working' },
  })
  return { workspace: { id: workspace.id, repoPath }, task: { id: task.id }, run: { id: run.id } }
}

describe('requestStop', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('kills the process, concludes the run, blocks the task, appends run.stopped', async () => {
    const { task, run } = fixture
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
    await new Promise((res) => child.once('spawn', res))
    const pid = child.pid ?? 0
    await prisma.agentRun.update({ where: { id: run.id }, data: { pid } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: run.id } })

    const result = await requestStop(run.id, 'meren')
    expect(result.ok).toBe(true)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('stopped')
    expect(after.endedAt).not.toBeNull()
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(taskAfter.status).toBe('blocked')
    expect(taskAfter.activeRunId).toBeNull()
    await new Promise((res) => setTimeout(res, 100))
    expect(isAlive(pid)).toBe(false)
  })

  it('still concludes a run whose process is already gone', async () => {
    const { run } = fixture
    await prisma.agentRun.update({ where: { id: run.id }, data: { pid: 999_999_999 } })
    const result = await requestStop(run.id, 'meren')
    expect(result.ok).toBe(true)
    const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_stopped' } })
    expect((event?.payload as { reason: string }).reason).toContain('no live process')
  })
})
