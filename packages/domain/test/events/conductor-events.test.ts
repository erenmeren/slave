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

  // Conductor Plan 4b (spec R8): a verification round starting, in a fresh worktree.
  it('accepts workspace.verification_started', () => {
    const parsed = executionEventSchema.safeParse({
      ...BASE,
      type: 'workspace.verification_started',
      payload: { version: 1, round: 1, runId: 'r1' },
    })
    expect(parsed.success).toBe(true)
  })

  // Conductor Plan 4b (spec R8/R9): a verification round's verdict, and its bounded failed keys.
  it('accepts workspace.verified with 60 failedKeys, and refuses 61', () => {
    const base = { ...BASE, type: 'workspace.verified' }
    const good = { version: 1, round: 1, runId: 'r1', pass: 1, fail: 1, unverifiable: 0, failedKeys: ['R2'] }
    expect(executionEventSchema.safeParse({ ...base, payload: good }).success).toBe(true)
    const sixty = Array.from({ length: 60 }, (_, i) => `R${i}`)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...good, failedKeys: sixty } }).success).toBe(true)
    const sixtyOne = [...sixty, 'R60']
    expect(executionEventSchema.safeParse({ ...base, payload: { ...good, failedKeys: sixtyOne } }).success).toBe(false)
  })

  // Conductor Plan 4b (plan D6/D7): the verification loop ended without acceptance.
  it('accepts workspace.goal_needs_human', () => {
    const parsed = executionEventSchema.safeParse({
      ...BASE,
      type: 'workspace.goal_needs_human',
      payload: { version: 1, reason: 'the verification round cap (3) was reached' },
    })
    expect(parsed.success).toBe(true)
  })

  // Conductor Plan 4b (plan D9): a person's retry-goal, with a fresh round window.
  it('accepts workspace.goal_retried', () => {
    const parsed = executionEventSchema.safeParse({
      ...BASE,
      type: 'workspace.goal_retried',
      payload: { version: 1, round: 3 },
    })
    expect(parsed.success).toBe(true)
  })

  // Conductor Plan 4b (plan D5): a verification rework charges no attempt.
  it('widens task.rework to carry an optional verificationRound and a zero attempt', () => {
    const base = { ...BASE, type: 'task.rework' }
    expect(
      executionEventSchema.safeParse({ ...base, payload: { reason: 'x', attempt: 0, verificationRound: 2 } }).success,
    ).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { reason: 'x', attempt: -1 } }).success).toBe(false)
    // The pre-4b shape still parses -- every row written before this milestone has no `verificationRound`.
    expect(executionEventSchema.safeParse({ ...base, payload: { reason: 'x', attempt: 2 } }).success).toBe(true)
  })
})
