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
