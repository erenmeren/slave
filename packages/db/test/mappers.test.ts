import type { AgentId } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import type { AgentRunRow, ExecutionEventRow, TaskRow } from '../src/client.js'
import { toExecutionEvent, toRunState, toTaskState } from '../src/mappers.js'

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    workspaceId: 'w1',
    title: 't',
    description: 'd',
    status: 'ready',
    priority: 0,
    requiredRole: null,
    assigneeId: 'agent-1',
    activeRunId: null,
    attempt: 1,
    maxAttempts: 3,
    lastRejectionReason: null,
    branch: null,
    createdBy: 'human',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    enqueuedAt: null,
    ...overrides,
  } as TaskRow
}

function eventRow(overrides: Partial<ExecutionEventRow> = {}): ExecutionEventRow {
  return {
    seq: 42n,
    ts: new Date('2026-08-18T12:34:56.000Z'),
    type: 'task_created',
    workspaceId: 'w1',
    taskId: 'task-1',
    agentId: null,
    runId: null,
    actor: 'system',
    payload: { title: 'Add checkout retry' },
    ...overrides,
  } as ExecutionEventRow
}

describe('toTaskState', () => {
  it('brands the assignee id', () => {
    const state = toTaskState(taskRow())
    const assignee: AgentId | null = state.assigneeId
    expect(assignee).toBe('agent-1')
  })

  it('carries the attempt counters through unchanged', () => {
    const state = toTaskState(taskRow({ attempt: 2, maxAttempts: 3 }))
    expect(state.attempt).toBe(2)
    expect(state.maxAttempts).toBe(3)
  })

  it('maps a null assignee to null rather than a branded empty string', () => {
    expect(toTaskState(taskRow({ assigneeId: null })).assigneeId).toBeNull()
  })
})

describe('toRunState', () => {
  it('reads status, tool calls, session and pause step from the row', () => {
    const row = {
      id: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      kind: 'implementation',
      status: 'paused',
      sessionId: 'sess-9',
      toolCalls: 7,
      pausedAtStep: 3,
      pauseReason: 'human',
      costUsd: 0.12,
      startedAt: new Date(),
      endedAt: null,
    } as AgentRunRow

    expect(toRunState(row)).toEqual({
      status: 'paused',
      toolCalls: 7,
      sessionId: 'sess-9',
      pausedAtStep: 3,
    })
  })
})

describe('toExecutionEvent', () => {
  it('converts seq to a number and ts to an ISO string', () => {
    const result = toExecutionEvent(eventRow())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.seq).toBe(42)
    expect(result.value.ts).toBe('2026-08-18T12:34:56.000Z')
  })

  it('translates the database event type back to the dotted domain spelling', () => {
    const result = toExecutionEvent(eventRow({ type: 'run_tool_call', payload: { name: 'Bash', summary: 'ls' } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe('run.tool_call')
  })

  it('returns an error for a payload the domain union rejects', () => {
    const result = toExecutionEvent(eventRow({ payload: { wrong: true } }))
    expect(result.ok).toBe(false)
  })

  it('returns an error for a database event type the domain does not know', () => {
    const result = toExecutionEvent(eventRow({ type: 'not_a_real_type' as ExecutionEventRow['type'] }))
    expect(result.ok).toBe(false)
  })
})
