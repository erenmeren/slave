import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'

const BASE = {
  seq: 1,
  ts: '2026-09-28T09:00:00.000Z',
  workspaceId: 'w1',
  actor: 'system',
} as const

describe('conductor events', () => {
  it('accepts workspace.requirements_set with the count', () => {
    const parsed = executionEventSchema.safeParse({
      ...BASE,
      type: 'workspace.requirements_set',
      payload: { version: 2, count: 7, setId: 's1' },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts workspace.conducted and refuses an unknown mode', () => {
    const base = { ...BASE, type: 'workspace.conducted' }
    const good = { version: 1, mode: 'partitioned', packages: ['cli', 'report', 'integration'], decisionId: 'd1', fallback: false }
    expect(executionEventSchema.safeParse({ ...base, payload: good }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...good, mode: 'both' } }).success).toBe(false)
  })

  // Conductor Plan 4a (spec R9): the goal version's delivery, from waiting to merged or abandoned.
  it('accepts workspace.goal_waiting, including a null waitingOn', () => {
    const base = { ...BASE, type: 'workspace.goal_waiting' }
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 2, waitingOn: 1 } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 2, waitingOn: null } }).success).toBe(true)
  })

  it('accepts workspace.goal_accepted with its rounds count', () => {
    const parsed = executionEventSchema.safeParse({
      ...BASE,
      type: 'workspace.goal_accepted',
      payload: { version: 1, rounds: 0 },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts workspace.goal_merged and refuses an unknown by', () => {
    const base = { ...BASE, type: 'workspace.goal_merged' }
    const good = { version: 1, branch: 'slaveofai/goal-v1-0c1d2e3f', into: 'main', commit: 'abc1234', by: 'system' }
    expect(executionEventSchema.safeParse({ ...base, payload: good }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...good, by: 'robot' } }).success).toBe(false)
  })

  it('accepts workspace.goal_abandoned up to 50 cancelled task ids, and refuses 51', () => {
    const base = { ...BASE, type: 'workspace.goal_abandoned' }
    const fifty = Array.from({ length: 50 }, (_, i) => `t${i}`)
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 1, cancelled: fifty } }).success).toBe(true)
    const fiftyOne = [...fifty, 't50']
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 1, cancelled: fiftyOne } }).success).toBe(false)
  })
})
