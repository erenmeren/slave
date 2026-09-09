import { prisma } from '@slave-of-ai/db/client'
import { decide, DEFAULT_GUARDRAIL_LIMITS, slaveId, taskId, type SchedulableTask, type World } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { requestStop } from '../../src/stop.js'
import { unblockTask } from '../../src/unblock.js'

interface Fixture {
  readonly workspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspaceId: workspace.id }
}

/** The fields every one of the four parks leaves behind, overridable per shape under test. */
async function makeBlockedTask(
  workspaceId: string,
  overrides: {
    readonly attempt?: number
    readonly maxAttempts?: number
    readonly activeRunId?: string | null
    readonly branch?: string | null
    readonly lastRejectionReason?: string | null
  } = {},
): Promise<{ readonly id: string }> {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Add the thing',
      description: 'make it work',
      status: 'blocked',
      requiredRole: 'backend',
      attempt: overrides.attempt ?? 0,
      maxAttempts: overrides.maxAttempts ?? 3,
      activeRunId: overrides.activeRunId ?? null,
      branch: overrides.branch === undefined ? 'slaveofai/T-abcd1234-add-the-thing' : overrides.branch,
      lastRejectionReason: overrides.lastRejectionReason ?? null,
    },
  })
  return { id: task.id }
}

/** Proves "becomes schedulable" the way `decide()` itself defines it, not by trusting the status
 *  string alone -- a status the pure scheduler does not treat as startable would make this verb's
 *  claim false even though the write succeeded. */
function schedulable(task: { readonly id: string; readonly status: string }): boolean {
  const schedulableTask: SchedulableTask = {
    id: taskId(task.id),
    status: task.status as SchedulableTask['status'],
    requiredRole: 'backend',
    priority: 1,
    dependenciesDone: true,
  }
  const world: World = {
    tasks: [schedulableTask],
    slaves: [{ id: slaveId('alex'), runtimeRoles: ['backend'], busy: false }],
    limits: DEFAULT_GUARDRAIL_LIMITS,
    stats: { activeRuns: 0, globalActiveRuns: 0, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
  }
  const commands = decide(world)
  return commands.some((c) => c.kind === 'start_run' && c.taskId === task.id)
}

describe('unblockTask', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    ;({ workspaceId } = await seed())
  })

  // M35 final review (minor): the four cases below used to all be named "moves a task blocked by
  // X.ts" while building the identical synthetic row (differing only in `attempt`) -- none of them
  // actually exercised the named park. `packages/control` cannot import `apps/orchestrator` (see
  // `git.ts`'s own doc comment on that boundary), so `tick.ts`'s worktree-conflict park and
  // `verify.ts`'s misconfiguration park are out of reach from this package's tests; `review.ts`'s
  // cap-exhausted park lives in `apps/orchestrator` too. `stop.ts`'s operator-cancel park DOES live
  // in this package, though, so that one case now drives the real thing (`requestStop`) rather than
  // a hand-built row -- the other three are renamed to say plainly that they build a row SHAPED
  // like what that park leaves behind, not that they ran the park itself.

  it('moves a task shaped like tick.ts\'s worktree-conflict park (attempt charged) to rework and makes it schedulable', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3, activeRunId: null })

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rework')
    expect(after.attempt).toBe(1)
    expect(schedulable(after)).toBe(true)
  })

  it('moves a task shaped like verify.ts\'s misconfiguration park (no attempt charged) to rework and makes it schedulable', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 0, maxAttempts: 3, activeRunId: null })

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rework')
    expect(after.attempt).toBe(0)
    expect(schedulable(after)).toBe(true)
  })

  it('moves a task shaped like review.ts\'s cap-exhausted park (no attempt charged) to rework and makes it schedulable', async (): Promise<void> => {
    // Reaching review at all means implementation and verify already passed once.
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3, activeRunId: null, lastRejectionReason: null })

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rework')
    expect(after.attempt).toBe(1)
    expect(schedulable(after)).toBe(true)
  })

  it('moves a task actually parked by stop.ts (operator cancel via requestStop, no attempt charged) to rework and makes it schedulable', async (): Promise<void> => {
    const slave = await prisma.slave.create({
      data: { team: { create: { workspaceId, name: 'Engineering' } }, name: 'Alex', role: 'backend' },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Add the thing',
        description: 'make it work',
        status: 'running',
        requiredRole: 'backend',
        attempt: 2,
        maxAttempts: 5,
        branch: 'slaveofai/T-abcd1234-add-the-thing',
      },
    })
    const run = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, status: 'working', pid: null },
    })
    await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

    // The real park: no pid to signal (null), so this only exercises `requestStop`'s own
    // `blocked`/`activeRunId: null` write for the task, not the kill.
    const stopped = await requestStop(run.id, 'meren')
    expect(stopped.ok).toBe(true)
    const blocked = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(blocked.status).toBe('blocked')
    expect(blocked.attempt).toBe(2)
    expect(blocked.activeRunId).toBeNull()

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rework')
    expect(after.attempt).toBe(2)
    expect(schedulable(after)).toBe(true)
  })

  it('emits task.unblocked with the actor human', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(true)

    const events = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_unblocked' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('human')
    expect(events[0]?.payload).toEqual({ attempt: 1, maxAttempts: 3 })
  })

  it('refuses a task that does not exist', async (): Promise<void> => {
    const result = await unblockTask('does-not-exist')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'task_not_found', taskId: 'does-not-exist' })
    expect(refusalText(result.error)).toContain('no task with id')
  })

  it.each(['ready', 'running', 'reviewing', 'done', 'failed', 'cancelled'] as const)(
    'refuses a task that is %s, not blocked',
    async (status): Promise<void> => {
      const task = await prisma.task.create({
        data: {
          workspaceId,
          title: 'Add the thing',
          description: 'make it work',
          status,
          maxAttempts: 3,
        },
      })

      const result = await unblockTask(task.id)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error).toEqual({ kind: 'task_not_blocked', taskId: task.id, status })
      expect(refusalText(result.error)).toContain('only a blocked task can be unblocked')
    },
  )

  it('refuses a blocked task that still carries an activeRunId, without touching it', async (): Promise<void> => {
    // None of the four real parks leaves this behind -- all four clear `activeRunId` in the same
    // write that sets `blocked` -- so this state can only be reached by hand here, standing in for
    // whatever future bug or manual edit would otherwise produce it.
    const slave = await prisma.slave.create({
      data: { team: { create: { workspaceId, name: 'Engineering' } }, name: 'Alex', role: 'backend' },
    })
    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add the thing', description: 'make it work', status: 'blocked', maxAttempts: 3 },
    })
    const run = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, status: 'starting' },
    })
    await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

    const result = await unblockTask(task.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'task_run_active', taskId: task.id, runId: run.id })
    expect(refusalText(result.error)).toContain('active run')

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('blocked')
    expect(after.activeRunId).toBe(run.id)
    expect(await prisma.executionEvent.count({ where: { taskId: task.id, type: 'task_unblocked' } })).toBe(0)
  })

  describe('the attempt ceiling', () => {
    it('refuses a task at its ceiling with no allowance, and does not touch it', async (): Promise<void> => {
      const task = await makeBlockedTask(workspaceId, { attempt: 3, maxAttempts: 3 })

      const result = await unblockTask(task.id)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error).toEqual({ kind: 'attempt_ceiling_reached', taskId: task.id, attempt: 3, maxAttempts: 3 })
      expect(refusalText(result.error)).toContain('ceiling')

      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(after.status).toBe('blocked')
      expect(after.maxAttempts).toBe(3)
      expect(await prisma.executionEvent.count({ where: { taskId: task.id, type: 'task_unblocked' } })).toBe(0)
    })

    it('refuses a task PAST its ceiling (maxAttempts lowered under it) the same way', async (): Promise<void> => {
      const task = await makeBlockedTask(workspaceId, { attempt: 4, maxAttempts: 3 })

      const result = await unblockTask(task.id)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error).toEqual({ kind: 'attempt_ceiling_reached', taskId: task.id, attempt: 4, maxAttempts: 3 })
    })

    it('with an explicit allowance, raises maxAttempts to attempt + 1 and unblocks -- attempt itself is untouched', async (): Promise<void> => {
      const task = await makeBlockedTask(workspaceId, { attempt: 3, maxAttempts: 3 })

      const result = await unblockTask(task.id, { allowAnotherAttempt: true })
      expect(result.ok).toBe(true)

      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(after.status).toBe('rework')
      expect(after.attempt).toBe(3)
      expect(after.maxAttempts).toBe(4)
      expect(schedulable(after)).toBe(true)

      const events = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_unblocked' } })
      expect(events[0]?.payload).toEqual({ attempt: 3, maxAttempts: 4 })
    })

    it('an allowance on a task NOT at its ceiling changes nothing about maxAttempts', async (): Promise<void> => {
      const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })

      const result = await unblockTask(task.id, { allowAnotherAttempt: true })
      expect(result.ok).toBe(true)

      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(after.maxAttempts).toBe(3)
    })
  })

  it('does NOT reset attempt on an ordinary unblock', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 2, maxAttempts: 3 })

    await unblockTask(task.id)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.attempt).toBe(2)
  })

  it('two concurrent unblocks: exactly one claims, the loser is refused task_not_blocked', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 0, maxAttempts: 3 })

    const [a, b] = await Promise.all([unblockTask(task.id), unblockTask(task.id)])
    const outcomes = [a, b]
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
    const refused = outcomes.find((r) => !r.ok)
    expect(refused && !refused.ok ? refused.error.kind : null).toBe('task_not_blocked')

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rework')
    expect(await prisma.executionEvent.count({ where: { taskId: task.id, type: 'task_unblocked' } })).toBe(1)
  })
})
