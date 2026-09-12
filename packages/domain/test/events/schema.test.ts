import { describe, expect, it } from 'vitest'
import { BROKER_REFUSAL_REASONS } from '../../src/broker/operations.js'
import { executionEventSchema, parseExecutionEvent } from '../../src/events/schema.js'

const BASE = {
  seq: 1,
  ts: '2026-08-17T17:01:00.000Z',
  workspaceId: 'ws-1',
  actor: 'system',
} as const

describe('parseExecutionEvent', () => {
  it('accepts a task.started event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.started',
      taskId: 'TASK-142',
      slaveId: 'alex',
      runId: 'run-1',
      payload: { title: 'Implement Checkout API' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.started')
  })

  it('accepts a run.tool_call event with its tool name', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'run.tool_call',
      runId: 'run-1',
      payload: { name: 'Edit', summary: 'CheckoutService.java' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'run.tool_call') {
      expect(result.value.payload.name).toBe('Edit')
    }
  })

  it.each([['toolu_01ABC'], [null]])('keeps run.tool_denied.toolUseId = %j through the parse (M21 C2)', (toolUseId) => {
    const result = parseExecutionEvent({ ...BASE, type: 'run.tool_denied', runId: 'run-1', payload: { tool: 'Bash', capability: 'run tests', toolUseId } })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'run.tool_denied') expect(result.value.payload.toolUseId).toBe(toolUseId)
  })

  it('tolerates a pre-B1 run.tool_denied without toolUseId', () => {
    const result = parseExecutionEvent({ ...BASE, type: 'run.tool_denied', runId: 'run-1', payload: { tool: 'Bash', capability: 'run tests' } })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'run.tool_denied') expect(result.value.payload.toolUseId).toBeUndefined()
  })

  it('accepts a slave.message_sent event with a category', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.message_sent',
      slaveId: 'alex',
      actor: 'human',
      payload: { category: 'instruction', body: 'Use Redis for this part.' },
    })
    expect(result.ok).toBe(true)
  })

  // M39 t2: the question row moved rather than a message being sent, so both ends of the move are
  // on the payload. A role-addressed question comes FROM a role and a slave-addressed one from a
  // slave id -- one of the two is always null, and which one is the fact a reader wants.
  it.each([
    [{ role: 'answerer', slaveId: null }],
    [{ role: null, slaveId: 'maya' }],
  ])('accepts a slave.message_reassigned event moving a question from %j', (from) => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.message_reassigned',
      slaveId: 'alex',
      payload: { messageId: 'm-1', decisionId: 'sd-1', from, to: { slaveId: 'zoe' }, actor: 'supervisor' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'slave.message_reassigned') {
      expect(result.value.payload.from).toEqual(from)
      expect(result.value.payload.to.slaveId).toBe('zoe')
    }
  })

  it('accepts a slave.message_reassigned event a human made, which names no decision', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.message_reassigned',
      actor: 'human',
      payload: {
        messageId: 'm-1',
        decisionId: null,
        from: { role: 'answerer', slaveId: null },
        to: { slaveId: 'zoe' },
        actor: 'operator',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'slave.message_reassigned') {
      expect(result.value.payload.decisionId).toBeNull()
    }
  })

  it('rejects a slave.message_reassigned event that names nobody to move the question to', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.message_reassigned',
      payload: {
        messageId: 'm-1',
        decisionId: null,
        from: { role: 'answerer', slaveId: null },
        to: { slaveId: '' },
        actor: 'supervisor',
      },
    })
    expect(result.ok).toBe(false)
  })

  // M37 t3: the two events the profile/role verbs write. Both carry the actor (envelope) and the
  // NEW value -- a hash for a profile (the text itself can be 16k characters and is already on the
  // row), the whole list for runtime roles (short, and the thing a reader actually wants).
  it('accepts a slave.profile_changed event for each target kind', () => {
    for (const target of ['slave', 'template', 'company_slave'] as const) {
      const result = parseExecutionEvent({
        ...BASE,
        type: 'slave.profile_changed',
        slaveId: 'alex',
        actor: 'human',
        payload: { target, targetId: 'id-1', sha256: 'a'.repeat(64), actor: 'operator' },
      })
      expect(result.ok).toBe(true)
    }
  })

  it('accepts a cleared profile as sha256: null', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.profile_changed',
      actor: 'human',
      payload: { target: 'slave', targetId: 'id-1', sha256: null, actor: 'operator' },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a slave.profile_changed with an unknown target', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'slave.profile_changed',
      actor: 'human',
      payload: { target: 'workspace', targetId: 'id-1', sha256: null, actor: 'operator' },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a slave.runtime_roles_changed event, including an emptied set', () => {
    for (const roles of [['backend', 'reviewer'], []]) {
      const result = parseExecutionEvent({
        ...BASE,
        type: 'slave.runtime_roles_changed',
        slaveId: 'alex',
        actor: 'human',
        payload: { slaveId: 'alex', roles, actor: 'operator' },
      })
      expect(result.ok).toBe(true)
      if (result.ok && result.value.type === 'slave.runtime_roles_changed') {
        expect(result.value.payload.roles).toEqual(roles)
      }
    }
  })

  it('rejects an unknown event type', () => {
    const result = parseExecutionEvent({ ...BASE, type: 'nonsense.happened', payload: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects an event whose payload does not match its type', () => {
    const result = parseExecutionEvent({ ...BASE, type: 'run.tool_call', runId: 'run-1', payload: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects an event missing its envelope fields', () => {
    const result = parseExecutionEvent({ type: 'task.started', payload: { title: 'x' } })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown actor', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'robot',
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a negative seq', () => {
    const result = parseExecutionEvent({
      ...BASE,
      seq: -1,
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-integer seq', () => {
    const result = parseExecutionEvent({
      ...BASE,
      seq: 1.5,
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-ISO-datetime ts', () => {
    const result = parseExecutionEvent({
      ...BASE,
      ts: 'yesterday',
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })

  it('parses each event type M3 adds', () => {
    const base = {
      seq: 1,
      ts: new Date().toISOString(),
      workspaceId: 'w1',
      actor: 'system' as const,
    }
    const cases = [
      { type: 'task.verifying', payload: { commandCount: 2 } },
      { type: 'task.verify_passed', payload: { branch: 'slaveofai/TASK-001-x' } },
      { type: 'task.verify_failed', payload: { command: 'npm test', exitCode: 1 } },
      { type: 'task.failed', payload: { reason: 'attempt cap reached' } },
      { type: 'run.output', payload: { text: 'hello' } },
      { type: 'run.pause_requested', payload: { requestedBy: 'operator' } },
      { type: 'run.stopped', payload: { reason: 'cancelled' } },
      { type: 'run.succeeded', payload: { numTurns: 4, costUsd: 0.12 } },
      { type: 'run.failed', payload: { reason: 'worktree provisioning failed' } },
    ]
    for (const c of cases) {
      const parsed = parseExecutionEvent({ ...base, ...c })
      expect(parsed.ok, `${c.type} should parse`).toBe(true)
    }
  })

  it('accepts a run.succeeded event with a null cost — an unmeasured run is not a free one', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'run.succeeded',
      runId: 'run-1',
      payload: { numTurns: 4, costUsd: null },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'run.succeeded') {
      expect(result.value.payload.costUsd).toBeNull()
    }
  })

  it('accepts run.resume_requested with an optional message', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'run.resume_requested',
      runId: 'run-1',
      payload: { requestedBy: 'operator', message: 'also create EXTRA.md' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('run.resume_requested')
  })

  it('accepts run.resume_requested with a null message', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'run.resume_requested',
      runId: 'run-1',
      payload: { requestedBy: 'operator', message: null },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.payload).toEqual({ requestedBy: 'operator', message: null })
  })

  it('accepts a task.dependency_added event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.dependency_added',
      taskId: 'TASK-1',
      payload: { dependsOnTaskId: 'TASK-2', dependsOnTitle: 'Build the API', requestedBy: 'human:eren' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.dependency_added')
  })

  it('accepts a task.dependency_removed event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.dependency_removed',
      taskId: 'TASK-1',
      payload: { dependsOnTaskId: 'TASK-2', dependsOnTitle: 'Build the API', requestedBy: 'human:eren' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.dependency_removed')
  })

  it('rejects a task.dependency_added event missing dependsOnTaskId', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.dependency_added',
      taskId: 'TASK-1',
      payload: { dependsOnTitle: 'Build the API', requestedBy: 'human:eren' },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a task.review_started event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.review_started',
      taskId: 'TASK-1',
      payload: { title: 'Add the thing' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.review_started')
  })

  it('accepts a task.review_approved event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.review_approved',
      taskId: 'TASK-1',
      payload: { reason: 'diff matches the task' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.review_approved')
  })

  it('accepts a task.review_rejected event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.review_rejected',
      taskId: 'TASK-1',
      payload: { reason: 'edge case unhandled', attempt: 2 },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.review_rejected')
  })

  it('rejects a task.review_rejected event with attempt 0', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.review_rejected',
      taskId: 'TASK-1',
      payload: { reason: 'edge case unhandled', attempt: 0 },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a task.merge_failed event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.merge_failed',
      taskId: 'TASK-1',
      payload: { reason: 'conflict in package.json' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.merge_failed')
  })

  it('accepts a task.integrated event with an empty payload', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.integrated',
      taskId: 'TASK-1',
      payload: {},
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.integrated')
  })

  it('accepts a task.unblocked event with its attempt/maxAttempts payload', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.unblocked',
      taskId: 'TASK-1',
      payload: { attempt: 2, maxAttempts: 3 },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.unblocked')
  })

  it('accepts a workspace.goal_set event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.goal_set',
      payload: { goal: 'Ship the checkout flow' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('workspace.goal_set')
  })

  it('rejects a workspace.goal_set event with an empty goal', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.goal_set',
      payload: { goal: '' },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a workspace.plan_created event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      payload: {
        goal: 'Ship the checkout flow',
        tasks: [{ id: 'TASK-1', title: 'Build the API', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('workspace.plan_created')
  })

  it('rejects a workspace.plan_created event with an empty goal', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      payload: {
        goal: '',
        tasks: [{ id: 'TASK-1', title: 'Build the API', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a workspace.plan_created event with an empty tasks array', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      payload: { goal: 'Ship the checkout flow', tasks: [] },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a workspace.company_assigned event with workers', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.company_assigned',
      payload: {
        company: 'Acme Corp',
        workers: [{ companySlaveId: 'ca-1', name: 'Alex', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('workspace.company_assigned')
  })

  it('rejects a workspace.company_assigned event whose worker is missing companySlaveId', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.company_assigned',
      payload: {
        company: 'Acme Corp',
        workers: [{ name: 'Alex', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a workspace.company_assigned event with an EMPTY workers array', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.company_assigned',
      payload: { company: 'Acme Corp', workers: [] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('workspace.company_assigned')
  })

  it('rejects a workspace.company_assigned event with an empty company', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.company_assigned',
      payload: { company: '', workers: [] },
    })
    expect(result.ok).toBe(false)
  })

  // M38 t1: the five events the Supervisor's control verbs write (spec §2). Every one is
  // appended with `actor: 'system'` -- the envelope enum has no `supervisor` member (spec E4).
  it('accepts a supervisor.decided event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.decided',
      taskId: 'TASK-1',
      payload: {
        decisionId: 'd-1',
        situationKind: 'review_cap_blocked',
        subjectId: 'TASK-1',
        tier: 'applied',
        decidedBy: 'model',
        action: { kind: 'unblock_task' },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'supervisor.decided') {
      expect(result.value.payload.action.kind).toBe('unblock_task')
    }
  })

  it('rejects a supervisor.decided event naming a situation kind or action the domain has no rule for', () => {
    const base = {
      ...BASE,
      type: 'supervisor.decided',
      payload: {
        decisionId: 'd-1',
        situationKind: 'review_cap_blocked',
        subjectId: 'TASK-1',
        tier: 'applied',
        decidedBy: 'model',
        action: { kind: 'unblock_task' },
      },
    }
    expect(parseExecutionEvent({ ...base, payload: { ...base.payload, situationKind: 'invented' } }).ok).toBe(false)
    expect(parseExecutionEvent({ ...base, payload: { ...base.payload, action: { kind: 'rm_rf' } } }).ok).toBe(false)
    expect(parseExecutionEvent({ ...base, payload: { ...base.payload, decidedBy: 'vibes' } }).ok).toBe(false)
    expect(parseExecutionEvent({ ...base, payload: { ...base.payload, decisionId: '' } }).ok).toBe(false)
  })

  it('accepts a supervisor.proposed event with its expiry', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.proposed',
      payload: {
        decisionId: 'd-1',
        situationKind: 'no_reviewer',
        subjectId: 'reviewer',
        action: { kind: 'set_runtime_roles' },
        expiresAt: '2026-09-10T17:01:00.000Z',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'supervisor.proposed') {
      expect(result.value.payload.expiresAt).toBe('2026-09-10T17:01:00.000Z')
    }
  })

  it('accepts a supervisor.applied event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.applied',
      payload: { decisionId: 'd-1', action: { kind: 'answer_question' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('supervisor.applied')
  })

  it.each([['approved'], ['rejected'], ['expired']])('accepts a supervisor.resolved event with outcome %s', (outcome) => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.resolved',
      actor: 'human',
      payload: { decisionId: 'd-1', outcome, reason: null },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'supervisor.resolved') {
      expect(result.value.payload.reason).toBeNull()
    }
  })

  it('rejects a supervisor.resolved event with an outcome the verbs never write', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.resolved',
      payload: { decisionId: 'd-1', outcome: 'ignored', reason: null },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a supervisor.failed event carrying the refusal that stopped it', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'supervisor.failed',
      payload: { decisionId: 'd-1', action: { kind: 'mark_task_failed' }, reason: 'task_not_failable' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'supervisor.failed') {
      expect(result.value.payload.reason).toBe('task_not_failable')
    }
  })

  // ---- M40 t1: goal versions, the delta re-plan and a cancelled task -----------------------

  it('accepts a workspace.goal_set event carrying its version and content hash', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'workspace.goal_set',
      payload: { goal: 'Ship the API', version: 2, sha256: 'a'.repeat(64) },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.goal_set') {
      expect(result.value.payload.version).toBe(2)
      expect(result.value.payload.sha256).toBe('a'.repeat(64))
    }
  })

  it('still accepts a pre-M40 workspace.goal_set with neither field -- read.ts throws on a row it cannot parse', () => {
    const result = parseExecutionEvent({ ...BASE, actor: 'human', type: 'workspace.goal_set', payload: { goal: 'Ship it' } })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.goal_set') {
      expect(result.value.payload.version).toBeUndefined()
    }
  })

  // ---- M45 t1: the words a person typed when they asked for a change ------------------------

  it('accepts a workspace.goal_set carrying the words a person requested', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'workspace.goal_set',
      payload: { goal: 'Ship it\n\n## Requested changes\n\n- 2026-09-10: add Apple Pay\n', version: 2, sha256: 'abc', request: 'add Apple Pay' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.goal_set') {
      expect(result.value.payload.request).toBe('add Apple Pay')
    }
  })

  it('still accepts a workspace.goal_set with no request -- every version before M45 has none', () => {
    const result = parseExecutionEvent({
      ...BASE, actor: 'human', type: 'workspace.goal_set', payload: { goal: 'Ship it', version: 1, sha256: 'abc' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.goal_set') {
      expect(result.value.payload.request).toBeUndefined()
    }
  })

  it('rejects a workspace.goal_set whose version is zero -- a set always makes a version', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'workspace.goal_set',
      payload: { goal: 'Ship it', version: 0, sha256: 'a'.repeat(64) },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a task.created event carrying the goal version it was planned from, and a null one', () => {
    const planned = parseExecutionEvent({
      ...BASE,
      type: 'task.created',
      taskId: 't1',
      payload: { title: 'Document the endpoint', goalVersion: 2 },
    })
    expect(planned.ok).toBe(true)
    if (planned.ok && planned.value.type === 'task.created') expect(planned.value.payload.goalVersion).toBe(2)

    const handMade = parseExecutionEvent({
      ...BASE,
      type: 'task.created',
      taskId: 't1',
      payload: { title: 'Fix the typo', goalVersion: null },
    })
    expect(handMade.ok).toBe(true)
    if (handMade.ok && handMade.value.type === 'task.created') expect(handMade.value.payload.goalVersion).toBeNull()
  })

  it('still accepts a pre-M40 task.created with only a title', () => {
    expect(parseExecutionEvent({ ...BASE, type: 'task.created', taskId: 't1', payload: { title: 'x' } }).ok).toBe(true)
  })

  it('accepts a workspace.plan_created event carrying the goal version its tasks were stamped with', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      payload: {
        goal: 'Ship the API',
        goalVersion: 1,
        tasks: [{ id: 't1', title: 'Build it', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.plan_created') expect(result.value.payload.goalVersion).toBe(1)
  })

  it('accepts a workspace.replan_started event naming the version and the run', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replan_started',
      runId: 'run-9',
      payload: { version: 2, runId: 'run-9' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.replan_started') {
      expect(result.value.payload).toEqual({ version: 2, runId: 'run-9' })
    }
  })

  it('rejects a workspace.replan_started with no run to attribute it to', () => {
    expect(parseExecutionEvent({ ...BASE, type: 'workspace.replan_started', payload: { version: 2 } }).ok).toBe(false)
  })

  it('accepts a workspace.replanned event with all three lists, dropped cancellations included', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      runId: 'run-9',
      payload: {
        version: 2,
        runId: 'run-9',
        added: ['t9'],
        proposedCancellations: ['t1'],
        droppedCancellations: [{ taskId: 't2', status: 'running' }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.replanned') {
      expect(result.value.payload.droppedCancellations).toEqual([{ taskId: 't2', status: 'running' }])
    }
  })

  it('carries the cancellable ids that never became a proposal, and reads a pre-fix row without them', () => {
    // M40 t3 fix round 1: a cooldown, a switched-off Supervisor or a `recordDecision` that threw
    // leaves a cancellation the model asked for with nothing to show for it. `failedProposals` is
    // where it is written down -- and optional, because the rows written before the field existed
    // must still parse.
    const withField = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: {
        version: 2,
        runId: 'run-9',
        added: [],
        proposedCancellations: ['t1'],
        droppedCancellations: [],
        failedProposals: ['t3'],
      },
    })
    expect(withField.ok).toBe(true)
    if (withField.ok && withField.value.type === 'workspace.replanned') {
      expect(withField.value.payload.failedProposals).toEqual(['t3'])
    }

    const withoutField = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: { version: 2, runId: 'run-9', added: [], proposedCancellations: [], droppedCancellations: [] },
    })
    expect(withoutField.ok).toBe(true)
    if (withoutField.ok && withoutField.value.type === 'workspace.replanned') {
      expect(withoutField.value.payload.failedProposals).toBeUndefined()
    }
  })

  it('accepts a workspace.replanned event whose three lists are all empty', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: { version: 2, runId: 'run-9', added: [], proposedCancellations: [], droppedCancellations: [] },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a workspace.replanned whose dropped cancellation has no status -- the refusal is the point', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: { version: 2, runId: 'run-9', added: [], proposedCancellations: [], droppedCancellations: [{ taskId: 't2' }] },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a task.cancelled event carrying the goal version whose work was dropped', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'task.cancelled',
      taskId: 't1',
      payload: { reason: 'the re-plan for goal v2 no longer needs it', goalVersion: 1 },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'task.cancelled') expect(result.value.payload.goalVersion).toBe(1)
  })

  it('accepts a task.cancelled event for a hand-made task, whose goal version is null', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'task.cancelled',
      taskId: 't1',
      payload: { reason: 'not needed', goalVersion: null },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a task.cancelled event with no reason -- a cancellation always says why', () => {
    expect(parseExecutionEvent({ ...BASE, type: 'task.cancelled', taskId: 't1', payload: { goalVersion: null } }).ok).toBe(false)
  })

  it('rejects an empty workspaceId', () => {
    const result = parseExecutionEvent({
      ...BASE,
      workspaceId: '',
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })
  it('keeps answeredBy on a slave.message_sent payload (M42 t1)', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'slave.message_sent',
      payload: { body: 'the retry queue', messageId: 'm1', kind: 'answer', answeredBy: 'supervisor' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'slave.message_sent') {
      expect(result.value.payload.answeredBy).toBe('supervisor')
    }
  })

  it('keeps status on a task.unblocked payload and still parses one without it (M42 t1)', () => {
    const withStatus = parseExecutionEvent({
      ...BASE,
      actor: 'human',
      type: 'task.unblocked',
      taskId: 't1',
      payload: { attempt: 1, maxAttempts: 3, status: 'reviewing' },
    })
    expect(withStatus.ok).toBe(true)
    if (withStatus.ok && withStatus.value.type === 'task.unblocked') {
      expect(withStatus.value.payload.status).toBe('reviewing')
    }
    // Every row written before M42 records the two counters and nothing else.
    expect(
      parseExecutionEvent({ ...BASE, actor: 'human', type: 'task.unblocked', taskId: 't1', payload: { attempt: 1, maxAttempts: 3 } }).ok,
    ).toBe(true)
  })
})

describe('parseExecutionEvent -- dropped capabilities (M47 R3, E14)', () => {
  it('accepts a workspace.plan_created carrying the capability keys the taxonomy did not have', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      runId: 'run-1',
      payload: {
        goal: 'ship it',
        goalVersion: 1,
        tasks: [{ id: 't1', title: 'Harden the endpoint', role: 'security' }],
        droppedCapabilities: ['nope.nothing'],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.plan_created') {
      expect(result.value.payload.droppedCapabilities).toEqual(['nope.nothing'])
    }
  })

  it('accepts a workspace.plan_created with no dropped capabilities at all -- every pre-M47 row has none', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'workspace.plan_created',
      runId: 'run-1',
      payload: { goal: 'ship it', tasks: [{ id: 't1', title: 'Harden the endpoint', role: 'security' }] },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'workspace.plan_created') {
      expect(result.value.payload.droppedCapabilities).toBeUndefined()
    }
  })

  it('accepts a workspace.replanned carrying them, and one without them', () => {
    const withField = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: {
        version: 2,
        runId: 'run-9',
        added: ['t9'],
        proposedCancellations: [],
        droppedCancellations: [],
        droppedCapabilities: ['nope.nothing'],
      },
    })
    expect(withField.ok).toBe(true)
    if (withField.ok && withField.value.type === 'workspace.replanned') {
      expect(withField.value.payload.droppedCapabilities).toEqual(['nope.nothing'])
    }

    const withoutField = parseExecutionEvent({
      ...BASE,
      type: 'workspace.replanned',
      payload: { version: 2, runId: 'run-9', added: [], proposedCancellations: [], droppedCancellations: [] },
    })
    expect(withoutField.ok).toBe(true)
    if (withoutField.ok && withoutField.value.type === 'workspace.replanned') {
      expect(withoutField.value.payload.droppedCapabilities).toBeUndefined()
    }
  })
})

describe('M48 events', () => {
  const envelope = { seq: 1, ts: '2026-09-11T00:00:00.000Z', workspaceId: 'w1', actor: 'slave' as const }

  it('accepts the runbook adherence block on a plan and on a re-plan, and accepts its absence', () => {
    const runbook = { id: 'rb1', key: 'feature-delivery', stagesCovered: ['design'], stagesMissing: ['release'] }
    expect(
      parseExecutionEvent({
        ...envelope,
        type: 'workspace.plan_created',
        payload: { goal: 'g', tasks: [{ id: 't1', title: 'T', role: 'backend' }], runbook },
      }).ok,
    ).toBe(true)
    expect(
      parseExecutionEvent({
        ...envelope,
        type: 'workspace.replanned',
        payload: { version: 2, runId: 'r1', added: [], proposedCancellations: [], droppedCancellations: [], runbook },
      }).ok,
    ).toBe(true)
    expect(
      parseExecutionEvent({
        ...envelope,
        type: 'workspace.plan_created',
        payload: { goal: 'g', tasks: [{ id: 't1', title: 'T', role: 'backend' }] },
      }).ok,
    ).toBe(true)
  })

  it('is the fiftieth type: workspace.runbook_adopted, with an optional cleared flag', () => {
    expect(
      parseExecutionEvent({
        ...envelope,
        actor: 'human',
        type: 'workspace.runbook_adopted',
        payload: { runbookId: 'rb1', key: 'feature-delivery', name: 'Feature delivery' },
      }).ok,
    ).toBe(true)
    expect(
      parseExecutionEvent({
        ...envelope,
        actor: 'human',
        type: 'workspace.runbook_adopted',
        payload: { runbookId: 'rb1', key: 'feature-delivery', name: 'Feature delivery', cleared: true },
      }).ok,
    ).toBe(true)
  })

  it('accepts a stage on task.verify_failed, and still accepts a row without one', () => {
    expect(parseExecutionEvent({ ...envelope, actor: 'system', type: 'task.verify_failed', payload: { command: 'npm test', exitCode: 1, stage: 'verify' } }).ok).toBe(true)
    expect(parseExecutionEvent({ ...envelope, actor: 'system', type: 'task.verify_failed', payload: { command: 'npm test', exitCode: 1 } }).ok).toBe(true)
  })
})

describe('M49 events', () => {
  const ENVELOPE = { seq: 1, ts: '2026-09-12T00:00:00.000Z', workspaceId: 'w1', actor: 'system' as const }

  it('M49 R4: memory.recorded carries what was learnt, and the task rides on the envelope', () => {
    const parsed = parseExecutionEvent({
      ...ENVELOPE,
      taskId: 't1',
      type: 'memory.recorded',
      payload: { memoryId: 'm1', type: 'fact', scope: 'workspace', status: 'verified', sourceKind: 'verification' },
    })
    expect(parsed.ok).toBe(true)
    // Plan erratum E13: the payload has no taskId of its own to disagree with the envelope's.
    expect(
      parseExecutionEvent({
        ...ENVELOPE,
        type: 'memory.recorded',
        payload: { memoryId: 'm1', type: 'fact', scope: 'workspace', status: 'verified', sourceKind: 'verification', taskId: 't1' },
      }).ok,
    ).toBe(false)
  })

  it('M49 R4: memory.changed names both ends of the move, and a reason only when there is one', () => {
    expect(
      parseExecutionEvent({ ...ENVELOPE, type: 'memory.changed', payload: { memoryId: 'm1', from: 'candidate', to: 'verified' } }).ok,
    ).toBe(true)
    expect(
      parseExecutionEvent({ ...ENVELOPE, type: 'memory.changed', payload: { memoryId: 'm1', from: 'verified', to: 'removed', reason: 'wrong' } }).ok,
    ).toBe(true)
    expect(
      parseExecutionEvent({ ...ENVELOPE, type: 'memory.changed', payload: { memoryId: 'm1', from: 'candidate', to: 'nonsense' } }).ok,
    ).toBe(false)
  })
})

describe('M50 events', () => {
  const ENVELOPE = { seq: 1, ts: '2026-09-12T00:00:00.000Z', workspaceId: 'w1', actor: 'system' as const }

  it('accepts slave.released, the 53rd type', () => {
    const parsed = parseExecutionEvent({
      ...ENVELOPE,
      type: 'slave.released',
      slaveId: 's9',
      payload: { slaveId: 's9', name: 'Robin', reason: 'the engagement is over', worktreesCollected: 1 },
    })
    expect(parsed.ok).toBe(true)
  })

  it('refuses a slave.released with no count -- the payload says what was cleaned up', () => {
    const parsed = parseExecutionEvent({
      ...ENVELOPE,
      type: 'slave.released',
      slaveId: 's9',
      payload: { slaveId: 's9', name: 'Robin', reason: 'the engagement is over' },
    })
    expect(parsed.ok).toBe(false)
  })

  it('accepts org.changed on the lifecycle field', () => {
    const parsed = parseExecutionEvent({
      ...ENVELOPE,
      actor: 'human',
      type: 'org.changed',
      slaveId: 's9',
      payload: { entity: 'slave', id: 's9', field: 'lifecycle', from: 'ephemeral', to: 'project' },
    })
    expect(parsed.ok).toBe(true)
  })

  it('accepts a worktree collected because a worker was released', () => {
    const parsed = parseExecutionEvent({
      ...ENVELOPE,
      type: 'task.worktree_collected',
      taskId: 't1',
      payload: { path: '/tmp/wt', reason: 'released', branch: 'feature/auth' },
    })
    expect(parsed.ok).toBe(true)
  })
})

describe('run.tool_call after M51 R1', () => {
  const base = {
    type: 'run.tool_call' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'slave' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('accepts the two new fields', () => {
    const parsed = parseExecutionEvent({
      ...base,
      payload: { name: 'Bash', summary: 'Bash npm test', toolUseId: 'toolu_1', argsHash: 'a'.repeat(64) },
    })
    expect(parsed.ok).toBe(true)
  })

  it('still accepts a pre-M51 row that has neither -- the run.tool_denied.toolUseId precedent', () => {
    // `packages/events/src/read.ts` THROWS on a row the domain cannot parse, so a required field
    // here would make every tool call written before this milestone unreadable and take the whole
    // activity stream down with it.
    expect(parseExecutionEvent({ ...base, payload: { name: 'Bash', summary: 'Bash npm test' } }).ok).toBe(true)
  })

  it('refuses an argsHash that is not a sha256 hex digest', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { name: 'Bash', summary: 's', toolUseId: 'x', argsHash: 'nope' } }).ok,
    ).toBe(false)
  })
})

describe('run.tool_result (the 54th type)', () => {
  const base = {
    type: 'run.tool_result' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'slave' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('carries the four bounded fields and nothing else', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'error', errorClass: 'timeout' },
      }).ok,
    ).toBe(true)
  })

  it('carries a null errorClass for a call that worked', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'ok', errorClass: null },
      }).ok,
    ).toBe(true)
  })

  it('is strict -- the result TEXT must never find a way in', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 't', toolName: 'Bash', outcome: 'ok', errorClass: null, content: 'the whole file' },
      }).ok,
    ).toBe(false)
  })

  it('caps errorClass at forty characters and refuses an unknown outcome', () => {
    const payload = { toolUseId: 't', toolName: 'Bash', outcome: 'error' as const, errorClass: 'x'.repeat(41) }
    expect(parseExecutionEvent({ ...base, payload }).ok).toBe(false)
    expect(parseExecutionEvent({ ...base, payload: { ...payload, outcome: 'maybe', errorClass: null } }).ok).toBe(false)
  })

  it('takes a class this version has never heard of -- the union types WRITERS, not the log', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 't', toolName: 'Bash', outcome: 'error', errorClass: 'quota_exhausted' },
      }).ok,
    ).toBe(true)
  })
})

describe('run.breaker (the 55th type)', () => {
  const base = {
    type: 'run.breaker' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'system' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('announces an escalation with its rung, its trip and the integer it fired on', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { level: 'steered', trip: 'repeated_call', count: 8, detail: 'Bash:aaaa' },
      }).ok,
    ).toBe(true)
  })

  it('never announces the top rung -- a STOP is a guardrail.tripped and nothing else', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'stop', trip: 'repeated_call', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })

  it('never announces a de-escalation -- stepping back down is silent', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'none', trip: 'repeated_call', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })

  it('refuses a trip kind the detector cannot produce', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'steered', trip: 'vibes', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })
})

describe('M52: the broker and the permission change (56th, 57th, 58th)', () => {
  it('parses broker.executed with the environment verbatim and the rest hashed', () => {
    const parsed = executionEventSchema.parse({
      type: 'broker.executed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      runId: 'r',
      slaveId: 's',
      actor: 'system',
      payload: {
        op: 'deploy_release',
        environment: 'staging',
        paramsHash: 'a'.repeat(64),
        exitCode: 0,
        durationMs: 1234,
      },
    })
    expect(parsed.type).toBe('broker.executed')
  })

  it('refuses a broker.executed payload carrying anything else -- the command, the output or a secret', () => {
    expect(() =>
      executionEventSchema.parse({
        type: 'broker.executed',
        seq: 1,
        ts: '2026-09-12T10:00:00.000Z',
        workspaceId: 'w',
        actor: 'system',
        payload: {
          op: 'deploy_release',
          environment: 'staging',
          paramsHash: 'a'.repeat(64),
          exitCode: 0,
          durationMs: 1,
          output: 'Deployed! token=hunter2',
        },
      }),
    ).toThrow()
  })

  it('parses broker.refused with one of the seven reasons', () => {
    for (const reason of BROKER_REFUSAL_REASONS) {
      const parsed = executionEventSchema.parse({
        type: 'broker.refused',
        seq: 1,
        ts: '2026-09-12T10:00:00.000Z',
        workspaceId: 'w',
        actor: 'system',
        payload: { op: 'deploy_release', reason },
      })
      expect(parsed.type).toBe('broker.refused')
    }
  })

  it('parses permission.changed with the from/to/by triple, either side nullable', () => {
    const parsed = executionEventSchema.parse({
      type: 'permission.changed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      slaveId: 's',
      actor: 'human',
      payload: {
        slaveId: 's',
        name: 'Alex',
        kind: 'network_fetch',
        kindLabel: 'Fetch over the network',
        from: null,
        to: 'allow',
        by: 'meren',
      },
    })
    expect(parsed.type).toBe('permission.changed')
  })

  it('parses a REVOKE -- `to: null` is "back to never asked", which is a real change', () => {
    const parsed = executionEventSchema.parse({
      type: 'permission.changed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      slaveId: 's',
      actor: 'human',
      payload: {
        slaveId: 's',
        name: 'Alex',
        kind: 'network_fetch',
        kindLabel: 'Fetch over the network',
        from: 'allow',
        to: null,
        by: 'meren',
      },
    })
    expect(parsed.type).toBe('permission.changed')
  })
})
