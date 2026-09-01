import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { emergencyStop } from '../../src/emergency.js'

interface Fixture {
  readonly workspace: { readonly id: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  // A real directory, not a placeholder: emergencyStop pauses the working run, and requestPause
  // reaches runFilePaths, whose statSync preflight refuses a repo path that does not exist.
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-emergency-'))
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
  return { workspace: { id: workspace.id }, task: { id: task.id }, run: { id: run.id } }
}

describe('emergencyStop', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('halts the workspace, pauses the working run, and trips one guardrail', async () => {
    const { workspace, run } = fixture

    const result = await emergencyStop(workspace.id, 'riley')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ engaged: true, requested: [run.id], refused: [] })

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.haltedReason).toBe('emergency stop by riley')
    expect(after.haltedAt).not.toBeNull()

    const pausedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(pausedRun.status).toBe('pause_requested')
    expect(pausedRun.pauseReason).toBe('emergency_stop')

    const guardrailEvents = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'guardrail_tripped' },
    })
    expect(guardrailEvents).toHaveLength(1)
    expect(guardrailEvents[0]?.payload).toEqual({ guardrail: 'emergency_stop', detail: 'engaged by riley' })
    expect(guardrailEvents[0]?.actor).toBe('human')
  })

  it('is not a refusal on a workspace already halted, and does not trip a second guardrail', async () => {
    const { workspace } = fixture

    const first = await emergencyStop(workspace.id, 'riley')
    expect(first.ok).toBe(true)

    const second = await emergencyStop(workspace.id, 'sam')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.engaged).toBe(false)

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    // The first operator's reason stands -- first-writer-wins.
    expect(after.haltedReason).toBe('emergency stop by riley')

    const guardrailEvents = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'guardrail_tripped' },
    })
    expect(guardrailEvents).toHaveLength(1)
  })

  it('refuses an unknown workspace', async () => {
    const result = await emergencyStop('00000000-0000-4000-8000-000000000000', 'riley')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'workspace_not_found', workspaceId: '00000000-0000-4000-8000-000000000000' })
  })

  it('buckets an already-paused run into refused but still succeeds', async () => {
    const { workspace, task, run } = fixture
    const { agentId } = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { agentId: true } })
    const alreadyPaused = await prisma.agentRun.create({
      data: { taskId: task.id, agentId, status: 'paused' },
    })

    const result = await emergencyStop(workspace.id, 'riley')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.engaged).toBe(true)
    expect(result.value.requested).toEqual([run.id])
    expect(result.value.refused).toEqual([alreadyPaused.id])
  })
})
