import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { runId } from '@ai-team-os/domain'
import { runFilePaths } from '../../src/paths.js'
import { requestPause } from '../../src/pause.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-pause-'))
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

describe('requestPause', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('claims the run, writes the flag file where the gate reads, and appends the event', async () => {
    const { workspace, run } = fixture
    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(true)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('human')

    const { pauseFlagPath } = runFilePaths(workspace.repoPath, runId(run.id))
    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('meren\n')

    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_pause_requested' },
      orderBy: { seq: 'desc' },
    })
    expect(event?.payload).toEqual({ requestedBy: 'meren' })
    expect(event?.actor).toBe('human')
  })

  it('refuses a run that already concluded, and writes nothing', async () => {
    const { workspace, run } = fixture
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })

    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('wrong_status')

    const { pauseFlagPath } = runFilePaths(workspace.repoPath, runId(run.id))
    expect(existsSync(pauseFlagPath)).toBe(false)
  })

  it('refuses an unknown run id', async () => {
    const result = await requestPause('00000000-0000-4000-8000-000000000000', 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })
})
