import { prisma } from '@slave-of-ai/db/client'
import {
  decide,
  DEFAULT_GUARDRAIL_LIMITS,
  RETRIES_MAX,
  REVIEW_RETRY_CAP,
  slaveId,
  taskId,
  type SchedulableTask,
  type World,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { requestStop } from '../../src/stop.js'
import { retryTask, unblockTask } from '../../src/unblock.js'

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

/** A team and one worker, for the cases that need real `SlaveRun` rows to reason about: since M42
 *  t1 `unblockTask` reads the task's runs to decide WHERE an unblock sends it. */
async function makeSlave(workspaceId: string): Promise<{ readonly id: string }> {
  const person = await prisma.person.create({ data: { name: 'Alex' } })
  return prisma.slave.create({
    data: { team: { create: { workspaceId, name: 'Engineering' } }, role: 'backend', person: { connect: { id: person.id } } },
  })
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
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    const slave = await makeSlave(workspaceId)
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
    // `status` says where the unblock actually sent it (M42 t1): `rework` for a task that was not
    // parked under review.
    expect(events[0]?.payload).toEqual({ attempt: 1, maxAttempts: 3, status: 'rework' })
  })

  it('stamps the envelope actor system when the Supervisor is the one unblocking (M38 t2)', async (): Promise<void> => {
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })

    const result = await unblockTask(task.id, { origin: 'system' })
    expect(result.ok).toBe(true)

    const events = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_unblocked' } })
    expect(events[0]?.actor).toBe('system')
    // Nothing else about the verb moves with the origin: the same write, the same payload.
    expect(events[0]?.payload).toEqual({ attempt: 1, maxAttempts: 3, status: 'rework' })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('rework')
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
    const slave = await makeSlave(workspaceId)
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
      expect(events[0]?.payload).toEqual({ attempt: 3, maxAttempts: 4, status: 'rework' })
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
  // M42 t1 (spec R6b): WHERE an unblock sends the task depends on which run parked it.
  it('returns a task blocked under review to reviewing, not rework, and charges no attempt', async (): Promise<void> => {
    // `rework` would spend an implementation attempt re-doing work nobody has judged wrong -- the
    // same argument `sweep.ts` makes for a review run's own release (M41 t3b).
    const slave = await makeSlave(workspaceId)
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'implementation', status: 'succeeded', startedAt: new Date(Date.now() - 60_000) },
    })
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'review', status: 'failed', startedAt: new Date() },
    })

    const result = await unblockTask(task.id)

    expect(result).toEqual({ ok: true, value: { status: 'reviewing' } })
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('reviewing')
    expect(after.attempt).toBe(1)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId, taskId: task.id }, orderBy: { seq: 'desc' } })
    expect((event.payload as { status?: string }).status).toBe('reviewing')
  })

  it('sends a task whose review budget is spent to rework instead: reviewing would re-park it on the next tick', async (): Promise<void> => {
    // `dispatchReview` counts review runs since the LATEST implementation run and parks the task
    // again the moment that count reaches REVIEW_RETRY_CAP. A fresh implementation run is the only
    // thing that resets it, so `rework` is the only unblock that actually moves.
    const slave = await makeSlave(workspaceId)
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })
    const impl = new Date(Date.now() - 60_000)
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'implementation', status: 'succeeded', startedAt: impl },
    })
    for (let i = 0; i < REVIEW_RETRY_CAP; i += 1) {
      await prisma.slaveRun.create({
        data: { taskId: task.id, slaveId: slave.id, kind: 'review', status: 'failed', startedAt: new Date(impl.getTime() + 1_000 * (i + 1)) },
      })
    }

    const result = await unblockTask(task.id)

    expect(result).toEqual({ ok: true, value: { status: 'rework' } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('rework')
  })

  it('still sends a task blocked under an implementation run to rework', async (): Promise<void> => {
    const slave = await makeSlave(workspaceId)
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'implementation', status: 'failed', startedAt: new Date() },
    })

    const result = await unblockTask(task.id)

    expect(result).toEqual({ ok: true, value: { status: 'rework' } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('rework')
  })

  it('does not check the attempt ceiling on the reviewing path: no implementation attempt is spent', async (): Promise<void> => {
    const slave = await makeSlave(workspaceId)
    const task = await makeBlockedTask(workspaceId, { attempt: 5, maxAttempts: 5 })
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'implementation', status: 'succeeded', startedAt: new Date(Date.now() - 60_000) },
    })
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'review', status: 'failed', startedAt: new Date() },
    })

    const result = await unblockTask(task.id)

    expect(result).toEqual({ ok: true, value: { status: 'reviewing' } })
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.maxAttempts).toBe(5)
    expect(after.attempt).toBe(5)
  })
})

/**
 * E R3 (self-running-project Task 4): the exit a `failed` task never had.
 *
 * `failed` is terminal everywhere else in the product -- `unblockTask` above will not touch it --
 * and this is the one verb that moves it, on its own attempts, at most twice. `rework` and never
 * `ready`, for `unblockTask`'s own reason: a retried task's worktree and branch are still on disk
 * from the run that failed, and `rework` is what tells `acquireWorktree` to adopt them.
 */
describe('retryTask', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlavePermission", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    ;({ workspaceId } = await seed())
  })

  const makeFailedTask = async (
    overrides: { readonly attempt?: number; readonly retries?: number; readonly activeRunId?: string | null } = {},
  ): Promise<{ readonly id: string }> =>
    prisma.task.create({
      data: {
        workspaceId,
        title: 'Read the docs',
        description: 'find out how the api works',
        status: 'failed',
        requiredRole: 'backend',
        attempt: overrides.attempt ?? 3,
        maxAttempts: 3,
        retries: overrides.retries ?? 0,
        activeRunId: overrides.activeRunId ?? null,
        branch: 'slaveofai/T-abcd1234-read-the-docs',
        lastRejectionReason: 'the last run was refused the network',
      },
    })

  const unblockedEvents = () =>
    prisma.executionEvent.findMany({ where: { workspaceId, type: 'task_unblocked' }, orderBy: { seq: 'asc' } })

  it('puts a failed task back to rework on fresh attempts, counts the retry and carries the steer note', async (): Promise<void> => {
    const task = await makeFailedTask({ attempt: 3, retries: 0 })

    const result = await retryTask(task.id, { reason: 'The last run was refused ‘Fetch over the network’.' })
    expect(result.ok).toBe(true)

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    // `rework`, not `ready`: the worktree the failed run left behind is adopted rather than fought.
    expect(after.status).toBe('rework')
    expect(after.attempt).toBe(0)
    expect(after.activeRunId).toBeNull()
    expect(after.retries).toBe(1)
    expect(after.maxAttempts).toBe(3)
    // The note the next run actually reads: `runContext`'s `rejection` section is on the
    // implementation order, and a rework run is an implementation run.
    expect(after.lastRejectionReason).toBe('The last run was refused ‘Fetch over the network’.')
    expect(schedulable(after)).toBe(true)

    const [event] = await unblockedEvents()
    expect(event?.actor).toBe('human')
    expect(event?.payload).toMatchObject({ status: 'rework', attempt: 0, retries: 1, reason: 'retry_task' })
  })

  it('grants the permission the diagnosis named BEFORE it moves the task, and says so in the event', async (): Promise<void> => {
    const slave = await makeSlave(workspaceId)
    const task = await makeFailedTask()

    const result = await retryTask(task.id, {
      grant: { slaveId: slave.id, permissionKind: 'network_fetch' },
      reason: 'The last run was refused the network.',
    })
    expect(result.ok).toBe(true)

    const permission = await prisma.slavePermission.findFirstOrThrow({ where: { slaveId: slave.id, kind: 'network_fetch' } })
    expect(permission.mode).toBe('allow')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('rework')
    const [event] = await unblockedEvents()
    expect(event?.payload).toMatchObject({ grant: { slaveId: slave.id, permissionKind: 'network_fetch' } })
  })

  // Fix round 1, Important 1: `failTask` stores WHY the task failed in the same column, and a
  // retry that carries no note of its own (Task 6's CLI and web callers) must not delete it.
  it('keeps the failure note when the retry carries no reason of its own', async (): Promise<void> => {
    const task = await makeFailedTask()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).lastRejectionReason).toBe(
      'the last run was refused the network',
    )

    expect((await retryTask(task.id)).ok).toBe(true)

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).lastRejectionReason).toBe(
      'the last run was refused the network',
    )
  })

  it('replaces the failure note when the retry carries one', async (): Promise<void> => {
    const task = await makeFailedTask()

    expect((await retryTask(task.id, { reason: 'Do not try the deploy again.' })).ok).toBe(true)

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).lastRejectionReason).toBe(
      'Do not try the deploy again.',
    )
  })

  // Fix round 1, Important 2: `candidates.ts` labels its steer remedy `steer: …` for the panel
  // and the decision row; the WORKER must never read the label. The prompt already says "A previous
  // attempt was rejected. Address this before anything else:" -- "steer: " after that is machinery.
  it('strips the steer label before the note reaches the worker', async (): Promise<void> => {
    const task = await makeFailedTask()

    expect((await retryTask(task.id, { reason: 'steer: keep to the brief' })).ok).toBe(true)

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).lastRejectionReason).toBe(
      'keep to the brief',
    )
  })

  it('stamps the envelope actor system when the Supervisor is the one retrying', async (): Promise<void> => {
    const task = await makeFailedTask()

    expect((await retryTask(task.id, {}, undefined, { origin: 'system' })).ok).toBe(true)

    expect((await unblockedEvents())[0]?.actor).toBe('system')
  })

  it.each(['ready', 'running', 'reviewing', 'rework', 'blocked', 'done', 'cancelled'] as const)(
    'refuses a task that is %s, not failed, and touches nothing',
    async (status): Promise<void> => {
      const task = await prisma.task.create({
        data: { workspaceId, title: 'Add the thing', description: 'make it work', status, maxAttempts: 3 },
      })

      const result = await retryTask(task.id)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error).toEqual({ kind: 'task_not_failed', taskId: task.id, status })
      expect(refusalText(result.error)).toContain('only a failed task can be retried')
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(status)
      expect(await unblockedEvents()).toHaveLength(0)
    },
  )

  it('refuses a task that does not exist', async (): Promise<void> => {
    const result = await retryTask('does-not-exist')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error).toEqual({ kind: 'task_not_found', taskId: 'does-not-exist' })
  })

  it('refuses a third retry: two remedies that did not work is the finding, not a reason for a third', async (): Promise<void> => {
    const task = await makeFailedTask({ retries: RETRIES_MAX })

    const result = await retryTask(task.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'retry_ceiling_reached', taskId: task.id, retries: RETRIES_MAX, limit: RETRIES_MAX })
    expect(refusalText(result.error)).toContain('retried')

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('failed')
    expect(after.retries).toBe(RETRIES_MAX)
    expect(await unblockedEvents()).toHaveLength(0)
  })

  it('a grant that is refused aborts the retry: the task is left exactly as it was', async (): Promise<void> => {
    const task = await makeFailedTask()

    const result = await retryTask(task.id, { grant: { slaveId: 'nobody', permissionKind: 'network_fetch' } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({ kind: 'slave_not_found', slaveId: 'nobody' })

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('failed')
    expect(after.attempt).toBe(3)
    expect(after.retries).toBe(0)
    expect(await unblockedEvents()).toHaveLength(0)
  })

  it('a grant of an operation nothing knows is refused, and writes no permission row', async (): Promise<void> => {
    const slave = await makeSlave(workspaceId)
    const task = await makeFailedTask()

    const result = await retryTask(task.id, { grant: { slaveId: slave.id, permissionKind: 'sudo_everything' } })
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('invalid_tool')
    expect(await prisma.slavePermission.count()).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('failed')
  })

  it('two concurrent retries: exactly one claims, the loser is refused task_not_failed', async (): Promise<void> => {
    const task = await makeFailedTask()

    const [a, b] = await Promise.all([retryTask(task.id), retryTask(task.id)])
    const outcomes = [a, b]
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
    expect(outcomes.find((r) => !r.ok)?.ok === false ? 'refused' : null).toBe('refused')

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.retries).toBe(1)
    expect(await unblockedEvents()).toHaveLength(1)
  })
})

/**
 * E R3 (self-running-project Task 4): the second destination for a `review_cap_blocked` park, for
 * the case the cap counted attempts that never judged anything -- a reviewer whose run broke.
 */
describe('unblockTask -- retryReview', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    ;({ workspaceId } = await seed())
  })

  it('sends a blocked task back to reviewing and stamps the window the next review counts from', async (): Promise<void> => {
    const slave = await makeSlave(workspaceId)
    const task = await makeBlockedTask(workspaceId, { attempt: 1, maxAttempts: 3 })
    // The state the cap park leaves: one implementation run and REVIEW_RETRY_CAP review runs after
    // it, so an ordinary unblock would pick `rework` -- the review budget is spent.
    const impl = new Date(Date.now() - 60_000)
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, kind: 'implementation', status: 'succeeded', startedAt: impl },
    })
    for (let i = 0; i < REVIEW_RETRY_CAP; i += 1) {
      await prisma.slaveRun.create({
        data: { taskId: task.id, slaveId: slave.id, kind: 'review', status: 'failed', startedAt: new Date(impl.getTime() + 1_000 * (i + 1)) },
      })
    }

    const before = Date.now()
    const result = await unblockTask(task.id, { retryReview: true })

    expect(result).toEqual({ ok: true, value: { status: 'reviewing' } })
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('reviewing')
    // No implementation attempt is spent: nobody has judged this work wrong.
    expect(after.attempt).toBe(1)
    expect(after.maxAttempts).toBe(3)
    expect(after.reviewWindowFrom?.getTime() ?? 0).toBeGreaterThanOrEqual(before)

    const [event] = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_unblocked' } })
    expect(event?.payload).toMatchObject({ status: 'reviewing', reason: 'retry_review' })
  })

  it('refuses a task that is not blocked, and stamps no window', async (): Promise<void> => {
    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add the thing', description: 'make it work', status: 'reviewing', maxAttempts: 3 },
    })

    const result = await unblockTask(task.id, { retryReview: true })
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error).toEqual({ kind: 'task_not_blocked', taskId: task.id, status: 'reviewing' })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).reviewWindowFrom).toBeNull()
  })
})
