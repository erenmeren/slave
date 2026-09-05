import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { runId } from '@slave-of-ai/domain'
import { runFilePaths } from '../../src/paths.js'
import { refusalText } from '../../src/refusal.js'
import { pauseActiveRuns, requestPause } from '../../src/pause.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly slave: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-pause-'))
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
  return { workspace: { id: workspace.id, repoPath }, task: { id: task.id }, slave: { id: slave.id }, run: { id: run.id } }
}

describe('requestPause', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('claims the run, writes the flag file where the gate reads, and appends the event', async () => {
    const { workspace, run } = fixture
    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(true)

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
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
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })

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
   * and would keep passing if the change were reverted. This one would not: the refusal it reads
   * back names `cursor`, and it can only have come from the Cursor branch of `signalPause`.
   *
   * What the run's provider being honoured LOOKS like changed in M13 Task 4: the pid-less Cursor
   * throw is now caught, the claim rolled back, and the failure returned as a refusal rather than
   * escaping as an exception (Decision 5). The fact under guard here is unchanged -- dispatch by
   * the row's own provider -- so this test keeps its name and reads the new outcome.
   */
  it("signals the run's own provider, not a constant -- so an unimplemented one surfaces", async () => {
    const { run } = fixture
    await prisma.slaveRun.update({ where: { id: run.id }, data: { provider: 'cursor' } })

    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('pause_unsignalled')
    expect(refusalText(result.error)).toMatch(/cursor/)

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('working')
  })

  it('writes the given category as the pause reason, not the human default', async () => {
    const { run } = fixture
    const result = await requestPause(run.id, 'budget guardrail', 'emergency_stop')
    expect(result.ok).toBe(true)

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.pauseReason).toBe('emergency_stop')
  })

  it('two concurrent requests: exactly one claims, the loser is told pause_requested', async () => {
    const { run } = fixture
    const [a, b] = await Promise.all([requestPause(run.id, 'meren'), requestPause(run.id, 'meren')])
    const outcomes = [a, b]
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
    const refused = outcomes.find((r) => !r.ok)
    expect(refused && !refused.ok && refused.error.kind).toBe('wrong_status')
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
  })

  it('a rollback restores the status the claim actually interrupted', async () => {
    // Make signalPause fail: pre-create the run's own directory read-only, so `runFilePaths`'s
    // `mkdirSync(dir, { recursive: true })` is a harmless no-op (the dir already exists) but the
    // flag write inside it hits EACCES. (A nonexistent parent -- e.g. under `/proc` -- was tried
    // first and hangs Node's recursive `mkdirSync` forever on this host; this reaches the same
    // failure without going anywhere near that.)
    const { run, workspace } = fixture
    const { runDir } = runFilePaths(workspace.repoPath, runId(run.id))
    chmodSync(runDir, 0o555)
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'resuming' } })
    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(false)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('resuming') // the claim's own reading, not a stale earlier read
  })
})

describe('pauseActiveRuns', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('requests pause on every active run and buckets refusals without throwing', async () => {
    const { workspace, task, run } = fixture
    const { slaveId } = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id }, select: { slaveId: true } })
    const alreadyPaused = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId, status: 'paused' },
    })

    const report = await pauseActiveRuns(workspace.id, 'budget guardrail', 'guardrail')

    expect(report.requested).toEqual([run.id])
    expect(report.refused).toEqual([alreadyPaused.id])

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
  })

  /**
   * A planning run (Task 6) has no `Task` row -- its only linkage to a workspace is
   * `slave -> team -> workspace`. Emergency stop fans out through `pauseActiveRuns`, so a
   * task-less run scoped out of its query would keep running through a halt an operator believes
   * paused everything.
   */
  it('requests pause on a task-less planning run', async () => {
    const { workspace, run } = fixture
    const { slaveId } = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id }, select: { slaveId: true } })
    const planningRun = await prisma.slaveRun.create({
      data: { slaveId, kind: 'planning', status: 'working' },
    })

    const report = await pauseActiveRuns(workspace.id, 'budget guardrail', 'guardrail')

    expect(report.requested).toContain(planningRun.id)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: planningRun.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
  })
})

/**
 * M13 Decision 5. A `cursor` run with no recorded pid. `signalPause` refuses that outright rather
 * than reporting a pause it did not perform (`canPauseMidRun: false` means ENDING THE PROCESS is
 * the pause, and with no pid there is nothing to end), so this is the real throw, not a mock.
 */
describe('a pause that cannot be signalled', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  async function unsignallableRun(status: 'working' | 'starting' | 'resuming'): Promise<string> {
    await prisma.slaveRun.update({
      where: { id: fixture.run.id },
      data: { provider: 'cursor', pid: null, status },
    })
    return fixture.run.id
  }

  it('restores the prior status, refuses, and appends no pause event', async (): Promise<void> => {
    const runId = await unsignallableRun('working')
    const result = await requestPause(runId, 'meren')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('pause_unsignalled')

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    // A run never parks in `pause_requested` with nothing coming (Decision 5).
    expect(after.status).toBe('working')
    expect(
      await prisma.executionEvent.count({ where: { runId, type: 'run_pause_requested' } }),
    ).toBe(0)
  })

  it('restores a resuming run to resuming, not to working', async (): Promise<void> => {
    const runId = await unsignallableRun('resuming')
    expect((await requestPause(runId, 'meren')).ok).toBe(false)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('resuming')
  })

  it('lands in pauseActiveRuns refused, and the fan-out keeps going', async (): Promise<void> => {
    const unsignallable = await unsignallableRun('working')
    // A second, ordinary run in the same workspace, AFTER the broken one, so a fan-out that
    // abandoned the loop on the first failure would leave this one unsignalled.
    const second = await prisma.slaveRun.create({
      data: { taskId: fixture.task.id, slaveId: fixture.slave.id, status: 'working' },
    })

    // `PauseFanoutReport` carries ids only, and the CLI renders `refused.length` as "already
    // concluding" -- so the log line is the ONLY place an operator can learn that an emergency
    // stop left a run running. It has to be as loud for a refusal as it was for the throw this
    // refusal replaced (M13 Task 4 review I1).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = await pauseActiveRuns(fixture.workspace.id, 'meren', 'emergency_stop')
    const logged = errorSpy.mock.calls.map((call) => String(call[0]))
    errorSpy.mockRestore()

    const line = logged.find((entry) => entry.includes(unsignallable))
    expect(line).toMatch(/cursor/)

    expect(report.refused).toContain(unsignallable)
    expect(report.requested).toContain(second.id)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: unsignallable } })).status).toBe('working')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('pause_requested')
  })
})
