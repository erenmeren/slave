import { describe, expect, it } from 'vitest'
import { parseExecutionEvent } from '../../src/events/schema.js'

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
      agentId: 'alex',
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

  it('accepts an agent.message_sent event with a category', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'agent.message_sent',
      agentId: 'alex',
      actor: 'human',
      payload: { category: 'instruction', body: 'Use Redis for this part.' },
    })
    expect(result.ok).toBe(true)
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
      { type: 'task.verify_passed', payload: { branch: 'aiteamos/TASK-001-x' } },
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
        workers: [{ name: 'Alex', role: 'backend' }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('workspace.company_assigned')
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
})
