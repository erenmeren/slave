import { prisma } from '@slave-of-ai/db/client'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceSpend } from '../../src/spend.js'
import { workspaceStats } from '../../src/stats.js'
import { loadSupervisorWorld } from '../../src/supervisorWorld.js'

const NOW = new Date('2026-09-09T12:00:00.000Z')
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
}

async function seed(
  data: { readonly goal?: string; readonly haltedReason?: string; readonly budgetUsd?: number | null } = {},
): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkout ${String(Math.random()).slice(2)}`,
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: [],
      ...(data.goal === undefined ? {} : { goal: data.goal }),
      ...(data.haltedReason === undefined ? {} : { haltedReason: data.haltedReason, haltedAt: NOW }),
      ...(data.budgetUsd === undefined ? {} : { budgetUsd: data.budgetUsd }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

async function makeTask(
  fixture: Fixture,
  data: {
    readonly title: string
    readonly status: 'ready' | 'blocked' | 'done' | 'failed' | 'reviewing'
    readonly requiredRole?: string | null
    readonly integratedAt?: Date | null
    readonly createdAt?: Date
  },
): Promise<string> {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      title: data.title,
      description: 'a task',
      status: data.status,
      requiredRole: data.requiredRole === undefined ? 'backend' : data.requiredRole,
      maxAttempts: 3,
      attempt: 1,
      ...(data.integratedAt === undefined ? {} : { integratedAt: data.integratedAt }),
      ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    },
  })
  return task.id
}

describe('loadSupervisorWorld', () => {
  beforeEach(reset)

  it('maps tasks with their dependents, integration-gated dependenciesDone, statusSince and latest guardrail', async (): Promise<void> => {
    const fixture = await seed()
    const doneUnintegrated = await makeTask(fixture, { title: 'the dependency', status: 'done', integratedAt: null })
    const blocked = await makeTask(fixture, { title: 'the dependent', status: 'blocked', createdAt: ago(3 * 3_600_000) })
    await prisma.taskDependency.create({ data: { taskId: blocked, dependsOnTaskId: doneUnintegrated } })

    // The newest `task.*` event is what `statusSince` reads; the older one and the run event in
    // between must not win.
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'task_created', actor: 'system', payload: {}, ts: ago(3 * 3_600_000) },
    })
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'task_rework', actor: 'system', payload: {}, ts: ago(90 * 60_000) },
    })
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'run_started', actor: 'system', payload: {}, ts: ago(30 * 60_000) },
    })
    await prisma.executionEvent.create({
      data: {
        workspaceId: fixture.workspaceId,
        taskId: blocked,
        type: 'guardrail_tripped',
        actor: 'system',
        payload: { guardrail: 'verify_failed', detail: 'nope' },
        ts: ago(120 * 60_000),
      },
    })
    await prisma.executionEvent.create({
      data: {
        workspaceId: fixture.workspaceId,
        taskId: blocked,
        type: 'guardrail_tripped',
        actor: 'system',
        payload: { guardrail: 'review_retry_cap_exhausted', detail: 'out of retries' },
        ts: ago(60 * 60_000),
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.now).toBe(NOW.getTime())
    const dependency = world.tasks.find((task) => task.id === doneUnintegrated)
    const dependent = world.tasks.find((task) => task.id === blocked)
    expect(dependency?.dependents).toBe(1)
    expect(dependency?.dependenciesDone).toBe(true)
    expect(dependency?.integratedAt).toBeNull()
    // `done` but never integrated: the dependent is NOT startable, exactly as `world.ts` gates it.
    expect(dependent?.dependenciesDone).toBe(false)
    expect(dependent?.dependents).toBe(0)
    expect(dependent?.statusSince).toBe(ago(90 * 60_000).getTime())
    expect(dependent?.latestGuardrail).toBe('review_retry_cap_exhausted')
    expect(dependency?.latestGuardrail).toBeNull()
  })

  it('falls back to createdAt for a task with no task.* event of its own', async (): Promise<void> => {
    const fixture = await seed()
    const createdAt = ago(5 * 3_600_000)
    const id = await makeTask(fixture, { title: 'untouched', status: 'ready', createdAt })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.tasks.find((task) => task.id === id)?.statusSince).toBe(createdAt.getTime())
  })

  it('drops a task with no required role and keeps one whose role is the empty string', async (): Promise<void> => {
    const fixture = await seed()
    const roleless = await makeTask(fixture, { title: 'roleless', status: 'ready', requiredRole: null })
    const anyRole = await makeTask(fixture, { title: 'any role will do', status: 'ready', requiredRole: '' })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.tasks.map((task) => task.id)).not.toContain(roleless)
    expect(world.tasks.find((task) => task.id === anyRole)?.requiredRole).toBe('')
  })

  it('reports a slave as busy only while it holds a non-terminal run', async (): Promise<void> => {
    const fixture = await seed()
    const busy = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    const idle = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Blair', role: 'QA Reviewer', runtimeRoles: [] },
    })
    await prisma.slaveRun.create({ data: { slaveId: busy.id, status: 'working', kind: 'implementation' } })
    await prisma.slaveRun.create({ data: { slaveId: idle.id, status: 'succeeded', kind: 'implementation' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.slaves.find((slave) => slave.id === busy.id)).toMatchObject({
      busy: true,
      name: 'Alex',
      role: 'Senior Engineer',
      runtimeRoles: ['backend'],
    })
    expect(world.slaves.find((slave) => slave.id === idle.id)?.busy).toBe(false)
  })

  it('carries only questions somebody is still waiting on', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    const finishedRun = await prisma.slaveRun.create({ data: { slaveId: asker.id, status: 'succeeded', kind: 'implementation' } })
    const pending = await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which branch?',
        expectsReply: true,
        createdAt: ago(45 * 60_000),
      },
    })
    // Nobody is waiting on this one any more -- its asker's run concluded.
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: finishedRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-2',
        kind: 'question',
        body: 'and this one?',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions).toHaveLength(1)
    expect(world.questions[0]).toMatchObject({
      messageId: pending.id,
      askerSlaveId: asker.id,
      recipientRole: 'reviewer',
      recipientSlaveId: null,
      createdAt: ago(45 * 60_000).getTime(),
    })
  })

  it('carries the last 24 hours of decisions with their tier, and nothing older', async (): Promise<void> => {
    const fixture = await seed()
    const row = {
      workspaceId: fixture.workspaceId,
      situationKind: 'review_cap_blocked' as const,
      subjectId: 'task-1',
      situation: {},
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'nothing to do',
      decidedBy: 'rules' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...row, tier: 'escalated', status: 'pending', createdAt: ago(60 * 60_000) },
    })
    await prisma.supervisorDecision.create({
      data: { ...row, subjectId: 'task-old', tier: 'applied', status: 'applied', createdAt: ago(25 * 3_600_000) },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.decisions).toHaveLength(1)
    expect(world.decisions[0]).toMatchObject({
      situationKind: 'review_cap_blocked',
      subjectId: 'task-1',
      status: 'pending',
      tier: 'escalated',
      createdAt: ago(60 * 60_000).getTime(),
      resolvedAt: null,
    })
  })

  it('reports the goal, the halt, the settings, and a budget exhausted by supervisor spend alone', async (): Promise<void> => {
    const fixture = await seed({ goal: 'ship checkout', haltedReason: 'budget_exhausted', budgetUsd: 2 })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { supervisorEnabled: false, supervisorProfile: 'be conservative' },
    })
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: fixture.workspaceId,
        situationKind: 'workspace_halted',
        subjectId: fixture.workspaceId,
        situation: {},
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'no_action' },
        rationale: 'x',
        tier: 'noop',
        status: 'applied',
        decidedBy: 'model',
        modelCalled: true,
        modelCostUsd: 2.5,
      },
    })

    const { world, settings } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.goal).toBe('ship checkout')
    expect(world.halted).toEqual({ reason: 'budget_exhausted' })
    expect(world.budgetExhausted).toBe(true)
    expect(settings).toEqual({ enabled: false, profile: 'be conservative' })
  })

  it('leaves an unbudgeted workspace unexhausted however much it spent', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: null })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: 99 } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.budgetExhausted).toBe(false)
  })
})

describe('the halt the Supervisor sees (erratum E7)', () => {
  beforeEach(reset)

  /** Spends `usd` on a concluded run, which is what a budget guardrail reads. */
  async function spend(fixture: Fixture, usd: number): Promise<void> {
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: `Spender ${String(Math.random()).slice(2)}`, role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: usd } })
  }

  it('prefers the durable reason when the workspace carries one', async (): Promise<void> => {
    const fixture = await seed({ haltedReason: 'verify command failed: npm test' })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'verify command failed: npm test' })
  })

  it('halts on an exhausted budget even though nothing wrote haltedReason', async (): Promise<void> => {
    // The regression this erratum fixes: only an emergency stop (and the pause/verify/merge halts)
    // ever writes `haltedReason`, so a workspace `decide()` had stopped scheduling entirely looked
    // perfectly healthy to the Supervisor -- routine actions applying, the model seam open.
    const fixture = await seed({ budgetUsd: 1 })
    await spend(fixture, 2)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'budget_exhausted' })
    expect(world.budgetExhausted).toBe(true)
  })

  it('halts on the circuit breaker', async (): Promise<void> => {
    const fixture = await seed()
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Unlucky', role: 'backend', runtimeRoles: ['backend'] },
    })
    for (let index = 0; index < 3; index += 1) {
      await prisma.slaveRun.create({
        data: { slaveId: slave.id, status: 'failed', kind: 'implementation', terminalAt: ago(index * 60_000) },
      })
    }

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'circuit_breaker' })
  })

  it('does NOT halt on a concurrency cap -- a busy workspace is not a stuck one', async (): Promise<void> => {
    const fixture = await seed()
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { maxConcurrentRuns: 1 } })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Busy', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    // `decide()` HAS halted scheduling here (concurrency halts it), and the Supervisor deliberately
    // does not agree: escalating "this workspace is halted" every time it is at its run cap would
    // put a proposal in front of a human for ordinary operation, and freeze every routine action
    // while it did.
    expect(world.halted).toBeNull()
  })

  it('leaves an idle, solvent, unbroken workspace unhalted', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: 100 })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toBeNull()
    expect(world.budgetExhausted).toBe(false)
  })
})

describe('workspaceStats', () => {
  beforeEach(reset)

  it('reads the limits, the run counts, the streak and the halt in one go', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: 5, haltedReason: 'emergency stop' })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation' } })
    await prisma.slaveRun.create({
      data: { slaveId: slave.id, status: 'failed', kind: 'implementation', costUsd: 1.25, terminalAt: NOW },
    })

    const snapshot = await workspaceStats(fixture.workspaceId)

    expect(snapshot.limits).toMatchObject({ budgetUsd: 5, maxConcurrentRuns: 3, maxGlobalConcurrentRuns: 6 })
    expect(snapshot.stats).toMatchObject({
      activeRuns: 1,
      spentUsd: 1.25,
      consecutiveFailures: 1,
      emergencyStopped: true,
    })
    expect(snapshot.stats.globalActiveRuns).toBeGreaterThanOrEqual(1)
    expect(snapshot.haltedReason).toBe('emergency stop')
    expect(snapshot.spend.runsMeasuredUsd).toBe(1.25)
  })
})

describe('workspaceSpend', () => {
  beforeEach(reset)

  it('adds measured run spend, measured supervisor spend, and every unmeasured model call at the per-call cap', async (): Promise<void> => {
    const fixture = await seed()
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: 1.5 } })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation', costUsd: null } })

    const decision = {
      workspaceId: fixture.workspaceId,
      situationKind: 'review_cap_blocked' as const,
      subjectId: 'task-1',
      situation: {},
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'x',
      tier: 'noop' as const,
      status: 'applied' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: 0.25 },
    })
    // A model call whose cost never came back: charged at the cap, never at zero.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: null },
    })
    // Erratum E6, and the reason `modelCalled` exists at all: the call was MADE, came back
    // unusable, and the rules chose -- so the row says `rules` while the money was still spent. It
    // is charged exactly like the model row above.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: true, modelCostUsd: null },
    })
    // A rules decision that called nobody adds nothing.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: false, modelCostUsd: null },
    })

    const spend = await workspaceSpend(fixture.workspaceId)
    expect(spend).toEqual({
      runsMeasuredUsd: 1.5,
      supervisorMeasuredUsd: 0.25,
      supervisorUnmeasuredCalls: 2,
      spentUsd: 1.5 + 0.25 + 2 * SUPERVISOR_PER_CALL_CAP_USD,
    })
  })

  it('reports zeros for a workspace that has spent nothing', async (): Promise<void> => {
    const fixture = await seed()
    expect(await workspaceSpend(fixture.workspaceId)).toEqual({
      runsMeasuredUsd: 0,
      supervisorMeasuredUsd: 0,
      supervisorUnmeasuredCalls: 0,
      spentUsd: 0,
    })
  })
})
