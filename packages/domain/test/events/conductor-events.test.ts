import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'
import { GOAL_REPORT_FILES_MAX } from '../../src/goalReport/constants.js'

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

  // Conductor Plan 5 (D3): the files a package's merge into its integration branch changed, as git
  // lists them. Optional, so every `task.done` written before Plan 5 still parses.
  it('task.done carries the files a package merge changed, and still parses without them', () => {
    const base = { ...BASE, taskId: 't1', type: 'task.done' }
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b' } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: ['a.py'], filesTotal: 1 } }).success).toBe(true)
    const tooMany = Array.from({ length: 501 }, (_, i) => `f${String(i)}`)
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: tooMany, filesTotal: 501 } }).success).toBe(false)
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: [''], filesTotal: 1 } }).success).toBe(false)
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: [], filesTotal: -1 } }).success).toBe(false)
  })

  it("task.done's files bound is the report's GOAL_REPORT_FILES_MAX", () => {
    const base = { ...BASE, taskId: 't1', type: 'task.done' }
    const atMax = Array.from({ length: GOAL_REPORT_FILES_MAX }, (_, i) => `f${String(i)}`)
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: atMax, filesTotal: 900 } }).success).toBe(true)
    const overMax = [...atMax, 'one-more']
    expect(executionEventSchema.safeParse({ ...base, payload: { branch: 'b', files: overMax, filesTotal: 900 } }).success).toBe(false)
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

  // Skeleton spec S7 and plan B D11: the smoke check's attempt, and its fix handed to the skeleton.
  it('accepts workspace.smoke_run, refusing outcome running and an output of 4001 characters', () => {
    const payload = { version: 1, round: 2, attemptId: 'a1', outcome: 'failed', exitCode: 1, durationMs: 1200, output: 'npm error Missing script: "start"', reworkedPackage: 'integration' }
    const base = { ...BASE, type: 'workspace.smoke_run' }
    expect(executionEventSchema.safeParse({ ...base, payload }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, outcome: 'running' } }).success).toBe(false)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, output: 'x'.repeat(4001) } }).success).toBe(false)
  })

  it('accepts workspace.smoke_handed_off, refusing a change of 2001 characters', () => {
    const payload = { version: 1, round: 1, attemptId: 'a1', fromPackage: 'integration', toPackage: 'skeleton', path: 'backend/package.json', change: 'add a "start" script' }
    const base = { ...BASE, type: 'workspace.smoke_handed_off' }
    expect(executionEventSchema.safeParse({ ...base, payload }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, change: 'x'.repeat(2001) } }).success).toBe(false)
  })

  it('accepts workspace.package_handed_off with a path or a package, refusing an unknown delivery and a change of 501 characters', () => {
    const payload = {
      version: 1, handOffId: 'h1', source: 'report', fromPackage: 'report', toPackage: 'skeleton',
      path: 'scripts/verify.sh', package: null, delivery: 'rework', change: 'run pytest -k report',
    }
    const base = { ...BASE, type: 'workspace.package_handed_off' }
    expect(executionEventSchema.safeParse({ ...base, payload }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, path: null, package: 'integration', toPackage: null, delivery: 'question' } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, fromPackage: null, source: 'answer' } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, delivery: 'dropped' } }).success).toBe(false)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...payload, change: 'x'.repeat(501) } }).success).toBe(false)
  })

  it('accepts task.rework with a hand-off reopen count', () => {
    const base = { ...BASE, type: 'task.rework', taskId: 'T-1' }
    expect(executionEventSchema.safeParse({ ...base, payload: { reason: 'asked', attempt: 0, handOffReopen: 1 } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { reason: 'asked', attempt: 0, handOffReopen: 0 } }).success).toBe(false)
  })

  // Final wave M5: the goal pass's own retry of an accepted version whose branch moved says why.
  it('accepts workspace.goal_retried with cause branch_moved, and no other cause', () => {
    const base = { ...BASE, type: 'workspace.goal_retried' }
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 1, round: 2, cause: 'branch_moved' } }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { version: 1, round: 2, cause: 'the person' } }).success).toBe(false)
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
