import { loadSupervisorWorld, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK,
  SUPERVISOR_PER_CALL_CAP_USD,
  WAITING_STALE_MS,
} from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_SUPERVISION, supervise } from '../../src/supervisor.js'

const NOW = new Date('2026-09-09T12:00:00.000Z')
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
const clock = (): Date => NOW

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

interface Recorder {
  readonly decider: ModelDecider
  readonly calls: { readonly model: string; readonly prompt: string; readonly maxBudgetUsd: number }[]
}

/** A `ModelDecider` that answers from a script and remembers every call -- the only way a test can
 *  prove the budget and halt gates DID NOT call a model (spec §5). */
function recordingDecider(answer: ModelOutcome | ((call: number) => ModelOutcome)): Recorder {
  const calls: { model: string; prompt: string; maxBudgetUsd: number }[] = []
  const decider: ModelDecider = (input) => {
    calls.push({ model: input.model, prompt: input.prompt, maxBudgetUsd: input.maxBudgetUsd })
    return Promise.resolve(typeof answer === 'function' ? answer(calls.length - 1) : answer)
  }
  return { decider, calls }
}

const answering = (text: string, costUsd: number | null = 0.01): ModelOutcome => ({
  kind: 'answer',
  text,
  costUsd,
  tokens: { input: 100, output: 20 },
  numTurns: 1,
})

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveId: string
  readonly taskId: string
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

/**
 * One project holding exactly one situation: a task parked `blocked` by the review cap with an
 * attempt left, whose catalogue is `[unblock_task (applied), mark_task_failed (proposed),
 * escalate_to_human (escalated), no_action (noop)]` -- the shape every gate below is measured on.
 */
async function seed(
  options: {
    readonly haltedReason?: string
    readonly budgetUsd?: number | null
    readonly supervisorEnabled?: boolean
    readonly blockedTasks?: number
  } = {},
): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkout ${String(Math.random()).slice(2)}`,
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: [],
      ...(options.haltedReason === undefined ? {} : { haltedReason: options.haltedReason, haltedAt: NOW }),
      ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
      ...(options.supervisorEnabled === undefined ? {} : { supervisorEnabled: options.supervisorEnabled }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
  })
  const ids: string[] = []
  for (let index = 0; index < (options.blockedTasks ?? 1); index += 1) {
    ids.push(await blockedAtTheReviewCap(workspace.id, `Add the thing ${String(index)}`))
  }
  return { workspaceId: workspace.id, teamId: team.id, slaveId: slave.id, taskId: ids[0] ?? '' }
}

async function blockedAtTheReviewCap(workspaceId: string, title: string): Promise<string> {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title,
      description: 'make it work',
      status: 'blocked',
      requiredRole: 'backend',
      attempt: 1,
      maxAttempts: 3,
    },
  })
  await prisma.executionEvent.create({
    data: {
      workspaceId,
      taskId: task.id,
      type: 'guardrail_tripped',
      actor: 'system',
      payload: { guardrail: 'review_retry_cap_exhausted', detail: 'out of review retries' },
      ts: ago(60 * 60_000),
    },
  })
  return task.id
}

/** Every decision the pass wrote. Ordered by `createdAt`, which a fixed clock makes a TIE for
 *  every row of one pass -- so a test with more than one row asserts on the set, never the order. */
const decisions = (workspaceId: string) =>
  prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

describe('supervise', () => {
  beforeEach(reset)

  it('lets the model pick from the catalogue: the row says model, carries the cost, and the action reaches the world as system', async (): Promise<void> => {
    const fixture = await seed()
    const recorder = recordingDecider(
      answering('{"candidateIndex": 0, "rationale": "the task has an attempt left, so rework is the cheap exit"}'),
    )

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(report).toEqual({
      situations: 1,
      decided: 1,
      applied: 1,
      proposed: 0,
      skippedCooldown: 0,
      modelCalls: 1,
      rulesOnly: false,
    })
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.model).toBe('claude-sonnet-5')
    expect(recorder.calls[0]?.maxBudgetUsd).toBe(SUPERVISOR_PER_CALL_CAP_USD)
    expect(recorder.calls[0]?.prompt).toContain('"candidateIndex"')

    const rows = await decisions(fixture.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      situationKind: 'review_cap_blocked',
      tier: 'applied',
      status: 'applied',
      decidedBy: 'model',
      modelCalled: true,
      modelCostUsd: 0.01,
      rationale: 'the task has an attempt left, so rework is the cheap exit',
      action: { kind: 'unblock_task', taskId: fixture.taskId },
    })

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    const unblocked = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'task_unblocked' } })
    expect(unblocked.actor).toBe('system')
    const types = (await prisma.executionEvent.findMany({ where: { workspaceId: fixture.workspaceId }, orderBy: { seq: 'asc' } })).map(
      (event) => event.type,
    )
    expect(types).toContain('supervisor_decided')
    expect(types).toContain('supervisor_applied')
  })

  it('takes the model over the rules: an index the rules would never choose becomes a pending proposal', async (): Promise<void> => {
    const fixture = await seed()
    // Index 1 is `mark_task_failed` -- risky, so `proposed`. The rules would have picked index 0.
    const recorder = recordingDecider(answering('{"candidateIndex": 1, "rationale": "the work is not coming back"}'))

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(report.proposed).toBe(1)
    expect(report.applied).toBe(0)
    const rows = await decisions(fixture.workspaceId)
    expect(rows[0]).toMatchObject({ tier: 'proposed', status: 'pending', decidedBy: 'model' })
    expect(rows[0]?.action).toMatchObject({ kind: 'mark_task_failed' })
    // A proposal is NOT carried out: the task stays exactly where a human left it.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('blocked')
  })

  it('decides by the rules, and calls nothing, when no decider is wired', async (): Promise<void> => {
    const fixture = await seed()

    const report = await supervise({ workspaceId: fixture.workspaceId, now: clock })

    expect(report).toMatchObject({ decided: 1, applied: 1, modelCalls: 0, rulesOnly: true })
    const rows = await decisions(fixture.workspaceId)
    expect(rows[0]).toMatchObject({ decidedBy: 'rules', modelCalled: false, modelCostUsd: null, tier: 'applied' })
    expect(rows[0]?.action).toMatchObject({ kind: 'unblock_task' })
  })

  it('decides by the rules, and calls nothing, when a decider is wired with no model name', async (): Promise<void> => {
    const fixture = await seed()
    const recorder = recordingDecider(answering('{"candidateIndex": 1, "rationale": "never asked"}'))

    const report = await supervise({ workspaceId: fixture.workspaceId, decider: recorder.decider, now: clock })

    expect(recorder.calls).toHaveLength(0)
    expect(report).toMatchObject({ modelCalls: 0, rulesOnly: true })
    expect((await decisions(fixture.workspaceId))[0]).toMatchObject({ decidedBy: 'rules' })
  })

  it('never calls a model when the budget is exhausted', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: 1 })
    await prisma.slaveRun.create({
      data: { slaveId: fixture.slaveId, status: 'succeeded', kind: 'implementation', costUsd: 1.5 },
    })
    const recorder = recordingDecider(answering('{"candidateIndex": 1, "rationale": "never asked"}'))

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(recorder.calls).toHaveLength(0)
    // Two situations now, not one (erratum E7): an exhausted budget IS a halt to the Supervisor,
    // even though nothing wrote `haltedReason` -- so the workspace itself is escalated alongside
    // the blocked task, and the task's routine unblock becomes a proposal because a halted
    // workspace may only be proposed at.
    expect(report).toMatchObject({ situations: 2, decided: 2, applied: 0, proposed: 2, modelCalls: 0, rulesOnly: true })
    const rows = await decisions(fixture.workspaceId)
    expect(rows.every((row) => row.decidedBy === 'rules' && !row.modelCalled && row.modelCostUsd === null)).toBe(true)
    expect(rows.every((row) => row.status === 'pending')).toBe(true)
    expect(rows.map((row) => row.situationKind).toSorted()).toEqual(['review_cap_blocked', 'workspace_halted'])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('blocked')
  })

  it('escalates a halted workspace to a human without calling a model', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Halted Platform',
        repoPath: '/tmp/halted',
        verifyCommands: ['npm test'],
        setupCommands: [],
        haltedReason: 'consecutive_failures',
        haltedAt: NOW,
      },
    })
    const recorder = recordingDecider(answering('{"candidateIndex": 0, "rationale": "never asked"}'))

    const report = await supervise({
      workspaceId: workspace.id,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(recorder.calls).toHaveLength(0)
    expect(report).toMatchObject({ situations: 1, decided: 1, applied: 0, proposed: 1, modelCalls: 0, rulesOnly: true })
    const rows = await decisions(workspace.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ situationKind: 'workspace_halted', tier: 'escalated', status: 'pending', decidedBy: 'rules' })
  })

  it('falls back to the rules on an answer that will not parse, and still records what the call cost', async (): Promise<void> => {
    const fixture = await seed()
    const recorder = recordingDecider(answering('I would probably unblock it, honestly.', 0.02))

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(recorder.calls).toHaveLength(1)
    expect(report).toMatchObject({ decided: 1, modelCalls: 1, rulesOnly: false })
    expect((await decisions(fixture.workspaceId))[0]).toMatchObject({
      decidedBy: 'rules',
      // Erratum E6: the rules chose, and the call still happened -- which is what makes the money
      // findable later even when the provider reported no cost.
      modelCalled: true,
      modelCostUsd: 0.02,
      tier: 'applied',
    })
  })

  it('falls back to the rules on an index outside the catalogue', async (): Promise<void> => {
    const fixture = await seed()
    const recorder = recordingDecider(answering('{"candidateIndex": 41, "rationale": "off the end"}', 0.03))

    await supervise({ workspaceId: fixture.workspaceId, decider: recorder.decider, model: 'claude-sonnet-5', now: clock })

    expect((await decisions(fixture.workspaceId))[0]).toMatchObject({
      decidedBy: 'rules',
      modelCalled: true,
      modelCostUsd: 0.03,
    })
  })

  it('falls back to the rules on a failed call and on an isolation breach, keeping each cost', async (): Promise<void> => {
    const fixture = await seed({ blockedTasks: 2 })
    const recorder = recordingDecider((call) =>
      call === 0
        ? { kind: 'failed', reason: 'timeout', costUsd: null, tokens: null }
        : { kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.05, tokens: null },
    )

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(report).toMatchObject({ situations: 2, decided: 2, modelCalls: 2 })
    const rows = await decisions(fixture.workspaceId)
    expect(rows.map((row) => row.decidedBy)).toEqual(['rules', 'rules'])
    expect(rows.map((row) => row.modelCalled)).toEqual([true, true])
    expect(rows.map((row) => row.modelCostUsd)).toEqual(expect.arrayContaining([null, 0.05]))
  })

  it('falls back to the rules when the decider itself throws', async (): Promise<void> => {
    const fixture = await seed()
    const decider: ModelDecider = () => Promise.reject(new Error('the CLI blew up'))
    // The warning is the point of the branch, so it is captured rather than left in the run's
    // output -- and asserted, so silencing it cannot hide it going missing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const report = await supervise({ workspaceId: fixture.workspaceId, decider, model: 'claude-sonnet-5', now: clock })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the CLI blew up'))
    warn.mockRestore()

    expect(report).toMatchObject({ decided: 1, modelCalls: 1 })
    // The call was made and blew up with no cost reported: charged at the cap (erratum E6).
    expect((await decisions(fixture.workspaceId))[0]).toMatchObject({
      decidedBy: 'rules',
      modelCalled: true,
      modelCostUsd: null,
    })
  })

  it('caps model decisions per pass and decides the rest by the rules', async (): Promise<void> => {
    const fixture = await seed({ blockedTasks: SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK + 1 })
    const recorder = recordingDecider(answering('{"candidateIndex": 0, "rationale": "rework is the cheap exit"}'))

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
    })

    expect(report.situations).toBe(SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK + 1)
    expect(report.modelCalls).toBe(SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK)
    expect(recorder.calls).toHaveLength(SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK)
    const rows = await decisions(fixture.workspaceId)
    expect(rows.filter((row) => row.decidedBy === 'model')).toHaveLength(SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK)
    expect(rows.filter((row) => row.decidedBy === 'rules')).toHaveLength(1)
  })

  it('writes nothing at all while the Supervisor is switched off, and does not even load a world', async (): Promise<void> => {
    const fixture = await seed({ supervisorEnabled: false })
    const recorder = recordingDecider(answering('{"candidateIndex": 0, "rationale": "never asked"}'))
    // Fix round 1, Important 1: "report only" has to be cheap. A daemon ticks once a second, and a
    // world load is a dozen round trips including two scans of the event log -- so the switch is
    // read first and nothing else happens. The loader is handed in so a call that must NOT happen
    // can be asserted on.
    const loads: string[] = []
    const loadWorld = async (workspaceId: string, now: Date) => {
      loads.push(workspaceId)
      return loadSupervisorWorld(workspaceId, now)
    }

    // Fix round 2: the switch stops it DECIDING, it does not freeze the questions it already
    // asked. A proposal past its TTL is retired even here -- otherwise a switched-off workspace
    // would keep stale proposals `pending`, and approvable, forever.
    const stale = await prisma.supervisorDecision.create({
      data: {
        workspaceId: fixture.workspaceId,
        situationKind: 'review_cap_blocked',
        subjectId: fixture.taskId,
        situation: {},
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'no_action' },
        rationale: 'asked while the Supervisor was still on',
        tier: 'escalated',
        status: 'pending',
        decidedBy: 'rules',
        createdAt: ago(48 * 3_600_000),
        expiresAt: ago(24 * 3_600_000),
      },
    })

    const report = await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
      loadWorld,
    })

    expect(report).toEqual({
      situations: 0,
      decided: 0,
      applied: 0,
      proposed: 0,
      skippedCooldown: 0,
      modelCalls: 0,
      rulesOnly: true,
    })
    expect(loads).toEqual([])
    expect(recorder.calls).toHaveLength(0)
    // The expired proposal is the ONLY row, and the only thing that changed.
    const rows = await decisions(fixture.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: stale.id, status: 'expired' })
    expect(await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'supervisor_decided' } })).toBe(0)
  })

  it("builds the prompt from the SNAPSHOT's profile, not the one read before the transaction", async (): Promise<void> => {
    // Fix round 2. The pre-transaction read decides only whether to load a world at all; the
    // profile that reaches a model has to be the one that was true inside the world the decision is
    // made on. The seam stands in for the operator who edits the profile between the two reads.
    const fixture = await seed()
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { supervisorProfile: 'the profile read before the transaction' },
    })
    const recorder = recordingDecider(answering('{"candidateIndex": 0, "rationale": "rework it"}'))

    await supervise({
      workspaceId: fixture.workspaceId,
      decider: recorder.decider,
      model: 'claude-sonnet-5',
      now: clock,
      loadWorld: async (workspaceId, now) => {
        const loaded = await loadSupervisorWorld(workspaceId, now)
        return { ...loaded, settings: { ...loaded.settings, profile: 'the profile inside the snapshot' } }
      },
    })

    expect(recorder.calls[0]?.prompt).toContain('the profile inside the snapshot')
    expect(recorder.calls[0]?.prompt).not.toContain('the profile read before the transaction')
  })

  it('loads exactly one world when the Supervisor is on', async (): Promise<void> => {
    // The other half of the check above: the seam is real, the default is the control loader, and
    // an enabled pass does reach it -- once.
    const fixture = await seed()
    const loads: string[] = []
    const report = await supervise({
      workspaceId: fixture.workspaceId,
      now: clock,
      loadWorld: async (workspaceId, now) => {
        loads.push(workspaceId)
        return loadSupervisorWorld(workspaceId, now)
      },
    })

    expect(loads).toEqual([fixture.workspaceId])
    expect(report.decided).toBe(1)
  })

  it('reports nothing for a workspace that no longer exists, rather than throwing', async (): Promise<void> => {
    expect(await supervise({ workspaceId: '00000000-0000-4000-8000-000000000000', now: clock })).toEqual(
      NO_SUPERVISION,
    )
  })

  it('does not decide the same situation twice inside the cooldown', async (): Promise<void> => {
    // A stale question the Supervisor nudges: the nudge writes no state, so the SITUATION is still
    // there on the next pass and only the cooldown can stop a second decision.
    const workspace = await prisma.workspace.create({
      data: { name: 'Waiting Platform', repoPath: '/tmp/waiting', verifyCommands: ['npm test'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const asker = await prisma.slave.create({
      data: { teamId: team.id, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    await prisma.slave.create({
      data: { teamId: team.id, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const askerRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: workspace.id,
        senderRunId: askerRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which branch?',
        expectsReply: true,
        createdAt: new Date(NOW.getTime() - WAITING_STALE_MS - 60_000),
      },
    })

    const first = await supervise({ workspaceId: workspace.id, now: clock })
    expect(first).toMatchObject({ situations: 1, decided: 1, applied: 1 })
    expect((await decisions(workspace.id))[0]).toMatchObject({ situationKind: 'waiting_stale', tier: 'applied' })

    const second = await supervise({ workspaceId: workspace.id, now: clock })
    expect(second).toMatchObject({ situations: 0, decided: 0, skippedCooldown: 0 })
    expect(await decisions(workspace.id)).toHaveLength(1)
  })

  it('counts a cooldown refusal rather than failing the pass', async (): Promise<void> => {
    const fixture = await seed()
    // An OPEN proposal for the same key, older than the world loader's 24 h window -- so
    // `filterFresh` cannot see it and the situation reaches `recordDecision`, which holds the real
    // gate and refuses. That refusal is a skip, never a failure.
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: fixture.workspaceId,
        situationKind: 'review_cap_blocked',
        subjectId: fixture.taskId,
        situation: {},
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'no_action' },
        rationale: 'already waiting on a human',
        tier: 'escalated',
        status: 'pending',
        decidedBy: 'rules',
        createdAt: ago(48 * 3_600_000),
        // Deliberately still in the future, so `expirePendingDecisions` leaves it open.
        expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
      },
    })

    const report = await supervise({ workspaceId: fixture.workspaceId, now: clock })

    expect(report).toMatchObject({ situations: 1, decided: 0, skippedCooldown: 1 })
    expect(await decisions(fixture.workspaceId)).toHaveLength(1)
  })
})
