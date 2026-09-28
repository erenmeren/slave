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
})
