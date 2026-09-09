import { prisma } from '@slave-of-ai/db/client'
import type { TaskStatus } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { failTask } from '../../src/task.js'

interface Fixture {
  readonly workspaceId: string
  readonly userId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const user = await prisma.user.create({ data: { username: 'operator', passwordHash: 'x' } })
  return { workspaceId: workspace.id, userId: user.id }
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

async function makeTask(
  workspaceId: string,
  overrides: { readonly status?: TaskStatus; readonly activeRunId?: string | null } = {},
): Promise<{ readonly id: string }> {
  return prisma.task.create({
    data: {
      workspaceId,
      title: 'Add the thing',
      description: 'make it work',
      status: overrides.status ?? 'blocked',
      requiredRole: 'backend',
      attempt: 2,
      maxAttempts: 3,
      activeRunId: overrides.activeRunId ?? null,
      branch: 'slaveofai/T-abcd1234-add-the-thing',
    },
    select: { id: true },
  })
}

const failedEvents = () =>
  prisma.executionEvent.findMany({ where: { type: 'task_failed' }, orderBy: { seq: 'asc' } })

describe('failTask', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('fails a blocked task, keeps the reason on the row, and appends task.failed', async () => {
    const task = await makeTask(f.workspaceId, { status: 'blocked' })
    expect(await failTask(task.id, 'the dependency was cancelled')).toEqual({ ok: true, value: undefined })

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(row.status).toBe('failed')
    expect(row.lastRejectionReason).toBe('the dependency was cancelled')
    expect(row.attempt).toBe(2)

    const [event] = await failedEvents()
    expect(event?.actor).toBe('human')
    expect(event?.taskId).toBe(task.id)
    expect(event?.payload).toEqual({ reason: 'the dependency was cancelled' })
  })

  it('fails a task in rework too', async () => {
    const task = await makeTask(f.workspaceId, { status: 'rework' })
    expect((await failTask(task.id, 'no way forward')).ok).toBe(true)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('failed')
  })

  it('stamps the envelope actor system when the origin is the Supervisor, and the userId of a human principal', async () => {
    const bySystem = await makeTask(f.workspaceId)
    expect((await failTask(bySystem.id, 'dead end', 'system')).ok).toBe(true)
    const byHuman = await makeTask(f.workspaceId)
    expect((await failTask(byHuman.id, 'dead end', 'human', { userId: f.userId })).ok).toBe(true)

    const events = await failedEvents()
    expect(events[0]?.actor).toBe('system')
    expect(events[0]?.userId).toBeNull()
    expect(events[1]?.actor).toBe('human')
    expect(events[1]?.userId).toBe(f.userId)
  })

  it('refuses a task that does not exist', async () => {
    expect(await failTask('nope', 'because')).toEqual({ ok: false, error: { kind: 'task_not_found', taskId: 'nope' } })
    expect(await failedEvents()).toHaveLength(0)
  })

  it('refuses a task that still carries an activeRunId, without touching it', async () => {
    const team = await prisma.team.create({ data: { workspaceId: f.workspaceId, name: 'Engineering' } })
    const slave = await prisma.slave.create({
      data: { teamId: team.id, name: 'Maya', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    const task = await makeTask(f.workspaceId, { status: 'blocked' })
    const run = await prisma.slaveRun.create({
      data: { slaveId: slave.id, taskId: task.id, status: 'working' },
    })
    await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

    const result = await failTask(task.id, 'because')
    expect(result).toEqual({ ok: false, error: { kind: 'task_run_active', taskId: task.id, runId: run.id } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('blocked')
    expect(await failedEvents()).toHaveLength(0)
  })

  it('refuses every status that is not rework or blocked, naming the one it found', async () => {
    for (const status of ['backlog', 'ready', 'assigned', 'running', 'verifying', 'reviewing', 'merging', 'done', 'failed', 'cancelled', 'waiting'] as const) {
      const task = await makeTask(f.workspaceId, { status })
      const result = await failTask(task.id, 'because')
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toEqual({ kind: 'task_not_failable', taskId: task.id, status })
      expect(refusalText(result.error)).toContain(status)
    }
    expect(await failedEvents()).toHaveLength(0)
  })
})
