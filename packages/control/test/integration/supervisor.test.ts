import { createHash } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import {
  COOLDOWN_MS,
  PENDING_TTL_MS,
  PROFILE_MAX_CHARS,
  type Action,
  type Candidate,
  type Situation,
  type Tier,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import {
  applyDecision,
  approveDecision,
  expirePendingDecisions,
  listDecisions,
  recordDecision,
  rejectDecision,
  setSupervisorSettings,
} from '../../src/supervisor.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
  readonly userId: string
}

/** One project with a worker and a task parked in `blocked` -- the shape every routine Supervisor
 *  action in M38 acts on (`unblock_task`, `raise_max_attempts`, `mark_task_failed`). */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Maya', role: 'Senior Engineer', runtimeRoles: ['backend'] },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'blocked',
      requiredRole: 'backend',
      attempt: 1,
      maxAttempts: 3,
      branch: 'slaveofai/T-abcd1234-add-the-thing',
    },
  })
  const user = await prisma.user.create({ data: { username: 'operator', passwordHash: 'x' } })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id, userId: user.id }
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

const situationFor = (subjectId: string, kind: Situation['kind'] = 'review_cap_blocked'): Situation => ({
  kind,
  subjectId,
  summary: 'the task is parked at the review cap',
  facts: { taskId: subjectId, attempt: 1 },
})

const cand = (action: Action, tier: Tier): Candidate => ({ action, tier, why: 'because the rules said so' })

/** Records one decision the way the orchestrator would, with a single-candidate catalogue. */
async function record(
  fixture: Fixture,
  action: Action,
  tier: Tier,
  overrides: { readonly subjectId?: string; readonly now?: Date; readonly decidedBy?: 'model' | 'rules' } = {},
): Promise<{ readonly id: string; readonly status: string }> {
  const subjectId = overrides.subjectId ?? fixture.taskId
  const result = await recordDecision({
    workspaceId: fixture.workspaceId,
    situation: situationFor(subjectId),
    candidates: [cand(action, tier)],
    chosenIndex: 0,
    rationale: 'the one routine move left',
    decidedBy: overrides.decidedBy ?? 'rules',
    modelCostUsd: null,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  })
  if (!result.ok) throw new Error(`seeding a decision failed: ${refusalText(result.error)}`)
  return { id: result.value.id, status: result.value.status }
}

const eventsOfType = (type: string) =>
  prisma.executionEvent.findMany({ where: { type: type as never }, orderBy: { seq: 'asc' } })

describe('recordDecision', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  /**
   * Erratum E6. The three states of `modelCalled`, and the middle one is why the column exists: a
   * call was made, came back unusable, and the RULES chose -- the row is honest about who decided
   * and honest about the money having been spent, which `decidedBy` alone cannot be.
   */
  it('records whether a model call was actually made, independently of who decided', async () => {
    const record = async (decidedBy: 'model' | 'rules', modelCalled: boolean | undefined, subjectId: string) =>
      recordDecision({
        workspaceId: f.workspaceId,
        situation: situationFor(subjectId),
        candidates: [cand({ kind: 'no_action' }, 'noop')],
        chosenIndex: 0,
        rationale: 'nothing to do',
        decidedBy,
        modelCostUsd: null,
        ...(modelCalled === undefined ? {} : { modelCalled }),
      })

    const fellBack = await record('rules', true, 'task-fell-back')
    const neverCalled = await record('rules', undefined, 'task-never-called')
    const model = await record('model', undefined, 'task-model')
    for (const result of [fellBack, neverCalled, model]) expect(result.ok).toBe(true)
    if (!fellBack.ok || !neverCalled.ok || !model.ok) return

    const rowOf = async (id: string): Promise<boolean> =>
      (await prisma.supervisorDecision.findUniqueOrThrow({ where: { id } })).modelCalled
    expect(await rowOf(fellBack.value.id)).toBe(true)
    expect(await rowOf(neverCalled.value.id)).toBe(false)
    expect(await rowOf(model.value.id)).toBe(true)

    const views = await listDecisions(f.workspaceId)
    expect(views.find((view) => view.id === fellBack.value.id)).toMatchObject({ decidedBy: 'rules', modelCalled: true })
    expect(views.find((view) => view.id === neverCalled.value.id)).toMatchObject({ modelCalled: false })
  })

  it('records an applied-tier decision as applied with no expiry, and emits only supervisor.decided', async () => {
    const result = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'attempts remain',
      decidedBy: 'model',
      modelCostUsd: 0.42,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tier).toBe('applied')
    expect(result.value.status).toBe('applied')

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.status).toBe('applied')
    expect(row.expiresAt).toBeNull()
    expect(row.resolvedAt).toBeNull()
    expect(row.decidedBy).toBe('model')
    expect(row.modelCostUsd).toBe(0.42)
    // Erratum E6: not passed, and true anyway -- a model decision cannot have happened without a
    // call, so the input only has to be given for the case that default gets wrong.
    expect(row.modelCalled).toBe(true)
    expect(row.situationKind).toBe('review_cap_blocked')
    expect(row.subjectId).toBe(f.taskId)

    const [decided] = await eventsOfType('supervisor_decided')
    expect(decided?.actor).toBe('system')
    expect(decided?.payload).toEqual({
      decisionId: result.value.id,
      situationKind: 'review_cap_blocked',
      subjectId: f.taskId,
      tier: 'applied',
      decidedBy: 'model',
      action: { kind: 'unblock_task' },
    })
    expect(await eventsOfType('supervisor_proposed')).toHaveLength(0)
  })

  it('records a proposed-tier decision as pending, expiring PENDING_TTL_MS out, and emits supervisor.proposed too', async () => {
    const now = new Date('2026-09-09T10:00:00.000Z')
    const result = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')],
      chosenIndex: 0,
      rationale: 'nobody holds reviewer',
      decidedBy: 'rules',
      modelCostUsd: null,
      now,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('pending')

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.expiresAt?.getTime()).toBe(now.getTime() + PENDING_TTL_MS)

    const [proposed] = await eventsOfType('supervisor_proposed')
    expect(proposed?.actor).toBe('system')
    expect(proposed?.payload).toEqual({
      decisionId: result.value.id,
      situationKind: 'review_cap_blocked',
      subjectId: f.taskId,
      action: { kind: 'set_runtime_roles' },
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
    })
  })

  it('records an escalated-tier decision as pending and a noop-tier one as applied', async () => {
    const escalated = await record(f, { kind: 'escalate_to_human', summary: 'a human must look' }, 'escalated')
    expect(escalated.status).toBe('pending')

    const noop = await record(f, { kind: 'no_action' }, 'noop', { subjectId: 'some-other-subject' })
    expect(noop.status).toBe('applied')
    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: noop.id } })
    expect(row.expiresAt).toBeNull()
  })

  it('refuses a workspace whose Supervisor is switched off, writing no row and no event', async () => {
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { supervisorEnabled: false } })
    const result = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'attempts remain',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    expect(result).toEqual({ ok: false, error: { kind: 'supervisor_disabled', workspaceId: f.workspaceId } })
    expect(await prisma.supervisorDecision.count()).toBe(0)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown workspace', async () => {
    const result = await recordDecision({
      workspaceId: 'nope',
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'no_action' }, 'noop')],
      chosenIndex: 0,
      rationale: 'nothing to do',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    expect(result).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: 'nope' } })
  })

  it('refuses a second decision while one is still pending for the same key', async () => {
    const first = await record(f, { kind: 'escalate_to_human', summary: 'look at this' }, 'escalated')
    expect(first.status).toBe('pending')

    const second = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'try again',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.kind).toBe('supervisor_cooldown')
    if (second.error.kind !== 'supervisor_cooldown') return
    expect(second.error.situationKind).toBe('review_cap_blocked')
    expect(second.error.subjectId).toBe(f.taskId)
    expect(refusalText(second.error)).toContain('review_cap_blocked')
    expect(await prisma.supervisorDecision.count()).toBe(1)
  })

  it('cools a key from resolvedAt ?? createdAt, and exactly COOLDOWN_MS is still cooling', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z')
    const anchor = new Date(now.getTime() - COOLDOWN_MS)
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: f.workspaceId,
        situationKind: 'review_cap_blocked',
        subjectId: f.taskId,
        situation: situationFor(f.taskId) as never,
        candidates: [] as never,
        chosenIndex: 0,
        action: { kind: 'no_action' } as never,
        rationale: 'earlier',
        tier: 'proposed',
        status: 'rejected',
        decidedBy: 'rules',
        createdAt: new Date(now.getTime() - 10 * COOLDOWN_MS),
        resolvedAt: anchor,
      },
    })

    const cooling = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'again',
      decidedBy: 'rules',
      modelCostUsd: null,
      now,
    })
    expect(cooling.ok).toBe(false)
    if (!cooling.ok && cooling.error.kind === 'supervisor_cooldown') {
      expect(cooling.error.untilTs).toBe(new Date(anchor.getTime() + COOLDOWN_MS).toISOString())
    }

    const free = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'again',
      decidedBy: 'rules',
      modelCostUsd: null,
      now: new Date(now.getTime() + 1),
    })
    expect(free.ok).toBe(true)
  })

  it('anchors an auto-applied row (which never gets a resolvedAt) on its createdAt', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z')
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: f.workspaceId,
        situationKind: 'review_cap_blocked',
        subjectId: f.taskId,
        situation: situationFor(f.taskId) as never,
        candidates: [] as never,
        chosenIndex: 0,
        action: { kind: 'unblock_task', taskId: f.taskId } as never,
        rationale: 'earlier',
        tier: 'applied',
        status: 'applied',
        decidedBy: 'rules',
        createdAt: new Date(now.getTime() - COOLDOWN_MS + 1),
      },
    })
    const result = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor(f.taskId),
      candidates: [cand({ kind: 'unblock_task', taskId: f.taskId }, 'applied')],
      chosenIndex: 0,
      rationale: 'again',
      decidedBy: 'rules',
      modelCostUsd: null,
      now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('supervisor_cooldown')
  })

  it('cools only its own key -- another subject and another kind are free', async () => {
    await record(f, { kind: 'escalate_to_human', summary: 'look' }, 'escalated')
    const other = await recordDecision({
      workspaceId: f.workspaceId,
      situation: situationFor('another-task', 'task_failed'),
      candidates: [cand({ kind: 'no_action' }, 'noop')],
      chosenIndex: 0,
      rationale: 'nothing',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    expect(other.ok).toBe(true)
    expect(await prisma.supervisorDecision.count()).toBe(2)
  })
})

describe('applyDecision', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('unblock_task moves the task to rework, with a system-actor task.unblocked and supervisor.applied', async () => {
    const decision = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    expect(await applyDecision(decision.id, 'system')).toEqual({ ok: true, value: undefined })

    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.status).toBe('rework')
    expect(task.maxAttempts).toBe(3)

    const [unblocked] = await eventsOfType('task_unblocked')
    expect(unblocked?.actor).toBe('system')
    const [applied] = await eventsOfType('supervisor_applied')
    expect(applied?.actor).toBe('system')
    expect(applied?.payload).toEqual({ decisionId: decision.id, action: { kind: 'unblock_task' } })
  })

  it('raise_max_attempts unblocks a task at its ceiling, raising maxAttempts to attempt + 1', async () => {
    await prisma.task.update({ where: { id: f.taskId }, data: { attempt: 3, maxAttempts: 3 } })
    const decision = await record(f, { kind: 'raise_max_attempts', taskId: f.taskId }, 'proposed')
    expect((await applyDecision(decision.id, 'system')).ok).toBe(true)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.status).toBe('rework')
    expect(task.maxAttempts).toBe(4)
    expect(task.attempt).toBe(3)
  })

  it('set_runtime_roles writes the roles with the payload actor supervisor and a system envelope', async () => {
    const decision = await record(f, { kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')
    expect((await applyDecision(decision.id, 'system')).ok).toBe(true)

    expect((await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })).runtimeRoles).toEqual([
      'backend',
      'reviewer',
    ])
    const [changed] = await eventsOfType('slave_runtime_roles_changed')
    expect(changed?.actor).toBe('system')
    expect(changed?.payload).toEqual({ slaveId: f.slaveId, roles: ['backend', 'reviewer'], actor: 'supervisor' })
  })

  it('set_runtime_roles applies as a UNION, keeping a role granted while the proposal waited', async () => {
    // The proposal is computed the way `candidates.ts` computes one -- the slave's roles AT THAT
    // MOMENT (`['backend']`) plus the missing one.
    const decision = await record(f, { kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')
    // ...and then an operator grants `frontend` by hand while it sits pending (it may sit for a
    // whole `PENDING_TTL_MS`). Applying the stored array verbatim would take `frontend` straight
    // back off her, because `setRuntimeRoles` is a replacement.
    await prisma.slave.update({ where: { id: f.slaveId }, data: { runtimeRoles: ['backend', 'frontend'] } })

    expect((await approveDecision(decision.id, { userId: f.userId })).ok).toBe(true)

    const roles = (await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })).runtimeRoles
    expect(roles).toEqual(['backend', 'frontend', 'reviewer'])
    const [changed] = await eventsOfType('slave_runtime_roles_changed')
    expect(changed?.payload).toEqual({ slaveId: f.slaveId, roles: ['backend', 'frontend', 'reviewer'], actor: 'supervisor' })
  })

  it('set_runtime_roles refuses slave_not_found when the worker is gone by the time it is applied', async () => {
    const decision = await record(f, { kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')
    await prisma.slave.delete({ where: { id: f.slaveId } })

    const applied = await applyDecision(decision.id, 'system')
    expect(applied.ok).toBe(false)
    expect(applied.ok ? null : applied.error).toEqual({ kind: 'slave_not_found', slaveId: f.slaveId })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })).status).toBe('failed')
  })

  it('mark_task_failed fails the task and records the reason', async () => {
    const decision = await record(f, { kind: 'mark_task_failed', taskId: f.taskId, reason: 'a dead end' }, 'proposed')
    expect((await applyDecision(decision.id, 'system')).ok).toBe(true)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.status).toBe('failed')
    expect(task.lastRejectionReason).toBe('a dead end')
    const [failed] = await eventsOfType('task_failed')
    expect(failed?.actor).toBe('system')
    expect(failed?.payload).toEqual({ reason: 'a dead end' })
  })

  // M39 Task 2 replaces this: `answer_question` becomes `answerQuestion` with the row's draft and
  // `reassign_question` becomes `reassignQuestion`. Task 1 removed `nudge_answer` (the M38
  // placeholder this case used to cover) and put the two mailbox actions in the catalogue with no
  // verbs behind them yet, so what is asserted here is exactly that: they change nothing and claim
  // nothing.
  it('the mailbox actions reach the world not at all until their verbs land', async () => {
    const answer = await record(f, { kind: 'answer_question', messageId: 'm-1' }, 'applied')
    expect((await applyDecision(answer.id, 'system')).ok).toBe(true)
    const reassign = await record(f, { kind: 'reassign_question', messageId: 'm-1', toSlaveId: 's-2' }, 'applied', {
      subjectId: 'm-2',
    })
    expect((await applyDecision(reassign.id, 'system')).ok).toBe(true)

    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('blocked')
    expect(await eventsOfType('supervisor_applied')).toHaveLength(0)
  })

  it('escalate_to_human and no_action reach the world not at all -- and record no supervisor.applied', async () => {
    const escalated = await record(f, { kind: 'escalate_to_human', summary: 'look at this' }, 'escalated')
    expect((await applyDecision(escalated.id, 'system')).ok).toBe(true)
    const nothing = await record(f, { kind: 'no_action' }, 'noop', { subjectId: 'another' })
    expect((await applyDecision(nothing.id, 'system')).ok).toBe(true)

    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('blocked')
    expect(await eventsOfType('supervisor_applied')).toHaveLength(0)
  })

  it('records a refusing verb as a failed row with the refusal text, emits supervisor.failed, and RETURNS the refusal', async () => {
    await prisma.task.update({ where: { id: f.taskId }, data: { status: 'running' } })
    const decision = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')

    const result = await applyDecision(decision.id, 'system')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('task_not_blocked')

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
    expect(row.status).toBe('failed')
    expect(row.failureReason).toBe(refusalText(result.error))

    const [failed] = await eventsOfType('supervisor_failed')
    expect(failed?.actor).toBe('system')
    expect(failed?.payload).toEqual({
      decisionId: decision.id,
      action: { kind: 'unblock_task' },
      reason: refusalText(result.error),
    })
    expect(await eventsOfType('supervisor_applied')).toHaveLength(0)
  })

  it('refuses an unknown decision', async () => {
    expect(await applyDecision('nope', 'system')).toEqual({
      ok: false,
      error: { kind: 'decision_not_found', decisionId: 'nope' },
    })
  })

  it('with origin human, the verb it runs stamps a human actor and the principal userId', async () => {
    const decision = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    expect((await applyDecision(decision.id, 'human', { userId: f.userId })).ok).toBe(true)

    const [unblocked] = await eventsOfType('task_unblocked')
    expect(unblocked?.actor).toBe('human')
    expect(unblocked?.userId).toBe(f.userId)
  })
})

describe('approveDecision', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('applies the action, marks the row approved and emits supervisor.resolved with the approver', async () => {
    const decision = await record(f, { kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')
    expect(await approveDecision(decision.id, { userId: f.userId })).toEqual({ ok: true, value: undefined })

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
    expect(row.status).toBe('approved')
    expect(row.resolvedAt).not.toBeNull()
    expect(row.resolvedByUserId).toBe(f.userId)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })).runtimeRoles).toEqual([
      'backend',
      'reviewer',
    ])

    // A person resolved this, so the envelope says so -- the one supervisor.* event that is not
    // 'system'. WHICH person is userId here and resolvedByUserId on the row.
    const [resolved] = await eventsOfType('supervisor_resolved')
    expect(resolved?.actor).toBe('human')
    expect(resolved?.userId).toBe(f.userId)
    expect(resolved?.payload).toEqual({ decisionId: decision.id, outcome: 'approved', reason: null })
  })

  it('with no principal (the CLI has no session): applies, approves, and names no resolver', async () => {
    const decision = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'proposed')
    expect(await approveDecision(decision.id)).toEqual({ ok: true, value: undefined })

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
    expect(row.status).toBe('approved')
    expect(row.resolvedByUserId).toBeNull()

    // A human still acted -- the envelope actor says so -- but the CLI had no session to name.
    const [resolved] = await eventsOfType('supervisor_resolved')
    expect(resolved?.actor).toBe('human')
    expect(resolved?.userId).toBeNull()
  })

  it('refuses an unknown decision and a decision that is not pending', async () => {
    expect(await approveDecision('nope', { userId: f.userId })).toEqual({
      ok: false,
      error: { kind: 'decision_not_found', decisionId: 'nope' },
    })

    const applied = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    const result = await approveDecision(applied.id, { userId: f.userId })
    expect(result).toEqual({
      ok: false,
      error: { kind: 'decision_not_pending', decisionId: applied.id, status: 'applied' },
    })
  })

  it('a second approval of the same decision is refused decision_not_pending', async () => {
    const decision = await record(f, { kind: 'raise_max_attempts', taskId: f.taskId }, 'proposed')
    await prisma.task.update({ where: { id: f.taskId }, data: { attempt: 3, maxAttempts: 3 } })
    expect((await approveDecision(decision.id, { userId: f.userId })).ok).toBe(true)

    const second = await approveDecision(decision.id, { userId: f.userId })
    expect(second.ok).toBe(false)
    if (!second.ok && second.error.kind === 'decision_not_pending') {
      expect(second.error.status).toBe('approved')
    }
    expect(await eventsOfType('supervisor_resolved')).toHaveLength(1)
  })

  it('on a refusing verb: the row is failed but still carries who resolved it, and the refusal comes back', async () => {
    await prisma.task.update({ where: { id: f.taskId }, data: { status: 'running' } })
    const decision = await record(f, { kind: 'raise_max_attempts', taskId: f.taskId }, 'proposed')

    const result = await approveDecision(decision.id, { userId: f.userId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('task_not_blocked')

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
    expect(row.status).toBe('failed')
    expect(row.failureReason).toBe(refusalText(result.error))
    expect(row.resolvedByUserId).toBe(f.userId)
    expect(row.resolvedAt).not.toBeNull()
  })
})

describe('rejectDecision', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('rejects a pending proposal without applying it, carrying the reason into the event', async () => {
    const decision = await record(f, { kind: 'set_runtime_roles', slaveId: f.slaveId, roles: ['backend', 'reviewer'] }, 'proposed')
    expect(await rejectDecision(decision.id, { userId: f.userId }, '  Maya is on leave  ')).toEqual({
      ok: true,
      value: undefined,
    })

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
    expect(row.status).toBe('rejected')
    expect(row.resolvedByUserId).toBe(f.userId)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })).runtimeRoles).toEqual(['backend'])

    const [resolved] = await eventsOfType('supervisor_resolved')
    expect(resolved?.actor).toBe('human')
    expect(resolved?.userId).toBe(f.userId)
    expect(resolved?.payload).toEqual({ decisionId: decision.id, outcome: 'rejected', reason: 'Maya is on leave' })
  })

  it('records no reason when none was given', async () => {
    const decision = await record(f, { kind: 'escalate_to_human', summary: 'look' }, 'escalated')
    expect((await rejectDecision(decision.id, { userId: f.userId })).ok).toBe(true)
    const [resolved] = await eventsOfType('supervisor_resolved')
    expect((resolved?.payload as { reason: unknown }).reason).toBeNull()
  })

  it('refuses an unknown decision and one that is not pending', async () => {
    expect(await rejectDecision('nope', { userId: f.userId })).toEqual({
      ok: false,
      error: { kind: 'decision_not_found', decisionId: 'nope' },
    })
    const applied = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    expect(await rejectDecision(applied.id, { userId: f.userId })).toEqual({
      ok: false,
      error: { kind: 'decision_not_pending', decisionId: applied.id, status: 'applied' },
    })
  })
})

describe('expirePendingDecisions', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('retires only the pending rows whose expiry has passed, and says how many', async () => {
    const now = new Date('2026-09-09T10:00:00.000Z')
    const stale = await record(f, { kind: 'escalate_to_human', summary: 'old' }, 'escalated', { now })
    const fresh = await record(f, { kind: 'escalate_to_human', summary: 'new' }, 'escalated', {
      now,
      subjectId: 'another-task',
    })
    await prisma.supervisorDecision.update({
      where: { id: fresh.id },
      data: { expiresAt: new Date(now.getTime() + PENDING_TTL_MS * 2) },
    })

    const expired = await expirePendingDecisions(f.workspaceId, new Date(now.getTime() + PENDING_TTL_MS))
    expect(expired).toBe(1)

    const staleRow = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: stale.id } })
    expect(staleRow.status).toBe('expired')
    expect(staleRow.resolvedAt).not.toBeNull()
    expect(staleRow.resolvedByUserId).toBeNull()
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('pending')

    // Nobody acted on this one -- the expiry IS the fact -- so this stays the Supervisor's own event.
    const [resolved] = await eventsOfType('supervisor_resolved')
    expect(resolved?.actor).toBe('system')
    expect(resolved?.userId).toBeNull()
    expect(resolved?.payload).toEqual({ decisionId: stale.id, outcome: 'expired', reason: null })
  })

  it('is a no-op when nothing is due, and never touches another workspace', async () => {
    const now = new Date('2026-09-09T10:00:00.000Z')
    await record(f, { kind: 'escalate_to_human', summary: 'mine' }, 'escalated', { now })
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['npm test'], setupCommands: [] },
    })

    expect(await expirePendingDecisions(other.id, new Date(now.getTime() + PENDING_TTL_MS * 10))).toBe(0)
    expect(await expirePendingDecisions(f.workspaceId, now)).toBe(0)
    expect(await eventsOfType('supervisor_resolved')).toHaveLength(0)
  })
})

describe('listDecisions', () => {
  let f: Fixture
  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('returns the project newest first, with the stored JSON parsed back into domain shapes', async () => {
    const first = await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    const second = await record(f, { kind: 'escalate_to_human', summary: 'look' }, 'escalated', { subjectId: 'other' })

    const views = await listDecisions(f.workspaceId)
    expect(views.map((view) => view.id)).toEqual([second.id, first.id])
    const [latest] = views
    expect(latest?.situation.kind).toBe('review_cap_blocked')
    expect(latest?.candidates).toHaveLength(1)
    expect(latest?.action).toEqual({ kind: 'escalate_to_human', summary: 'look' })
    expect(latest?.tier).toBe('escalated')
    expect(latest?.status).toBe('pending')
    expect(latest?.expiresAt).toEqual(expect.any(String))
    expect(latest?.resolvedAt).toBeNull()
    expect(latest?.createdAt).toEqual(expect.any(String))
  })

  it('filters to the pending ones and honours a limit', async () => {
    await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    const pending = await record(f, { kind: 'escalate_to_human', summary: 'look' }, 'escalated', { subjectId: 'other' })

    expect((await listDecisions(f.workspaceId, { pending: true })).map((view) => view.id)).toEqual([pending.id])
    expect(await listDecisions(f.workspaceId, { limit: 1 })).toHaveLength(1)
  })

  it('never shows another project rows', async () => {
    await record(f, { kind: 'unblock_task', taskId: f.taskId }, 'applied')
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['npm test'], setupCommands: [] },
    })
    expect(await listDecisions(other.id)).toHaveLength(0)
  })
})

describe('setSupervisorSettings', () => {
  let f: Fixture
  const settingsEvents = () =>
    prisma.executionEvent.findMany({ where: { type: 'workspace_settings_changed' }, orderBy: { seq: 'asc' } })

  beforeEach(async () => {
    await reset()
    f = await seed()
  })

  it('refuses an unknown project', async () => {
    expect(await setSupervisorSettings('nope', { enabled: false })).toEqual({
      ok: false,
      error: { kind: 'workspace_not_found', workspaceId: 'nope' },
    })
  })

  it('switches the Supervisor off, emitting one settings_changed for the field that moved', async () => {
    expect(await setSupervisorSettings(f.workspaceId, { enabled: false }, { userId: f.userId })).toEqual({
      ok: true,
      value: undefined,
    })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).supervisorEnabled).toBe(false)

    const events = await settingsEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('human')
    expect(events[0]?.userId).toBe(f.userId)
    expect(events[0]?.payload).toEqual({ field: 'supervisorEnabled', from: true, to: false })
  })

  it('stores a trimmed profile and records only its hash, never the text', async () => {
    expect((await setSupervisorSettings(f.workspaceId, { profile: '  be terse  ' })).ok).toBe(true)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).supervisorProfile).toBe(
      'be terse',
    )

    const [event] = await settingsEvents()
    expect(event?.payload).toEqual({
      field: 'supervisorProfile',
      from: null,
      to: createHash('sha256').update('be terse', 'utf8').digest('hex'),
    })
    expect(JSON.stringify(event?.payload)).not.toContain('be terse')
  })

  it('clears the profile on an emptied text, and on an explicit null', async () => {
    await setSupervisorSettings(f.workspaceId, { profile: 'be terse' })
    expect((await setSupervisorSettings(f.workspaceId, { profile: '   ' })).ok).toBe(true)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).supervisorProfile).toBeNull()

    await setSupervisorSettings(f.workspaceId, { profile: 'be terse' })
    expect((await setSupervisorSettings(f.workspaceId, { profile: null })).ok).toBe(true)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).supervisorProfile).toBeNull()
  })

  it('refuses a profile past the cap, measured after trimming, and writes nothing', async () => {
    const tooLong = `  ${'x'.repeat(PROFILE_MAX_CHARS + 1)}  `
    const result = await setSupervisorSettings(f.workspaceId, { profile: tooLong })
    expect(result).toEqual({
      ok: false,
      error: { kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: PROFILE_MAX_CHARS + 1 },
    })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).supervisorProfile).toBeNull()
    expect(await settingsEvents()).toHaveLength(0)
  })

  it('emits one event per field that actually moved, and nothing when nothing did', async () => {
    expect((await setSupervisorSettings(f.workspaceId, { enabled: false, profile: 'be terse' })).ok).toBe(true)
    expect(await settingsEvents()).toHaveLength(2)

    expect((await setSupervisorSettings(f.workspaceId, { enabled: false, profile: 'be terse' })).ok).toBe(true)
    expect(await settingsEvents()).toHaveLength(2)

    expect((await setSupervisorSettings(f.workspaceId, {})).ok).toBe(true)
    expect(await settingsEvents()).toHaveLength(2)
  })
})
