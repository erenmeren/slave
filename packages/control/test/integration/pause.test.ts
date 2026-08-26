import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { runId } from '@ai-team-os/domain'
import { runFilePaths } from '../../src/paths.js'
import { pauseActiveRuns, requestPause } from '../../src/pause.js'

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

  /**
   * The discriminating test for M12 Task 8's fix round: `requestPause` signals the RUN'S OWN
   * provider, not a constant. Every other test here leaves `provider` null and so exercises only
   * the `?? 'claude_code'` fallback -- which is byte-identical to the deleted `CURRENT_PROVIDER_KIND`
   * and would keep passing if the change were reverted. This one would not.
   *
   * It asserts today's behavior HONESTLY rather than the behavior we want: `signalPause` has no
   * Cursor branch yet (Series D), so the request throws AFTER the run was already claimed into
   * `pause_requested`. That claim-before-signal ordering is a real forward hazard -- an operator
   * would see a run marked pausing that nothing ever paused, and `controlRoute` has no catch, so
   * the request surfaces as a 500 rather than a refusal. Task 12 owns fixing it; this test is the
   * tripwire that will fail loudly the moment it does, forcing this expectation to be rewritten
   * deliberately instead of quietly.
   */
  it("signals the run's own provider, not a constant -- so an unimplemented one surfaces", async () => {
    const { run } = fixture
    await prisma.agentRun.update({ where: { id: run.id }, data: { provider: 'cursor' } })

    await expect(requestPause(run.id, 'meren')).rejects.toThrow(/cursor/)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
  })

  it('writes the given category as the pause reason, not the human default', async () => {
    const { run } = fixture
    const result = await requestPause(run.id, 'budget guardrail', 'emergency_stop')
    expect(result.ok).toBe(true)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.pauseReason).toBe('emergency_stop')
  })
})

describe('pauseActiveRuns', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('requests pause on every active run and buckets refusals without throwing', async () => {
    const { workspace, task, run } = fixture
    const { agentId } = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { agentId: true } })
    const alreadyPaused = await prisma.agentRun.create({
      data: { taskId: task.id, agentId, status: 'paused' },
    })

    const report = await pauseActiveRuns(workspace.id, 'budget guardrail', 'guardrail')

    expect(report.requested).toEqual([run.id])
    expect(report.refused).toEqual([alreadyPaused.id])

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
  })

  /**
   * A planning run (Task 6) has no `Task` row -- its only linkage to a workspace is
   * `agent -> team -> workspace`. Emergency stop fans out through `pauseActiveRuns`, so a
   * task-less run scoped out of its query would keep running through a halt an operator believes
   * paused everything.
   */
  it('requests pause on a task-less planning run', async () => {
    const { workspace, run } = fixture
    const { agentId } = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { agentId: true } })
    const planningRun = await prisma.agentRun.create({
      data: { agentId, kind: 'planning', status: 'working' },
    })

    const report = await pauseActiveRuns(workspace.id, 'budget guardrail', 'guardrail')

    expect(report.requested).toContain(planningRun.id)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: planningRun.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
  })
})
