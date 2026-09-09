import { describe, expect, it } from 'vitest'
import { observe } from '../../src/supervisor/observe.js'
import { summarise } from '../../src/supervisor/report.js'
import { NOW, decision, slave, task, world } from './fixtures.js'

describe('summarise -- done', () => {
  it('separates integrated work from work still waiting for its merge', () => {
    const w = world({
      tasks: [
        task({ id: 't1', status: 'done', integratedAt: NOW - 1000 }),
        task({ id: 't2', status: 'done', integratedAt: NOW - 2000 }),
        task({ id: 't3', status: 'done', integratedAt: null }),
        task({ id: 't4', status: 'running' }),
      ],
    })
    expect(summarise(w).done).toEqual({ integrated: 2, awaitingIntegration: 1 })
  })
})

describe('summarise -- next', () => {
  it('counts the four states an operator asks about', () => {
    const w = world({
      tasks: [
        task({ id: 't1', status: 'ready' }),
        task({ id: 't2', status: 'ready' }),
        task({ id: 't3', status: 'running' }),
        task({ id: 't4', status: 'waiting' }),
        task({ id: 't5', status: 'blocked' }),
        task({ id: 't6', status: 'backlog' }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(summarise(w).next).toEqual({ ready: 2, running: 1, waiting: 1, blocked: 1 })
  })
})

describe('summarise -- stuck', () => {
  it('is exactly what observe sees, cooldowns and open decisions included', () => {
    const w = world({
      halted: { reason: 'budget_exhausted' },
      tasks: [task({ status: 'blocked' })],
      // A pending decision hides the situation from the DECIDER, never from the report: an
      // operator reading "what is stuck" must still see the thing a proposal is waiting on.
      decisions: [decision({ situationKind: 'workspace_halted', subjectId: 'ws-1', status: 'pending', tier: 'escalated' })],
    })
    expect(summarise(w).stuck).toEqual(observe(w))
    expect(summarise(w).stuck.map((s) => s.kind)).toEqual(['task_blocked_human', 'workspace_halted'])
  })
})

describe('summarise -- supervisor', () => {
  it('counts the recent decisions by what became of them, and by tier for escalations', () => {
    const w = world({
      decisions: [
        decision({ subjectId: 'a', status: 'applied', tier: 'applied', createdAt: NOW - 5000 }),
        decision({ subjectId: 'b', status: 'applied', tier: 'noop', createdAt: NOW - 4000 }),
        decision({ subjectId: 'c', status: 'pending', tier: 'proposed', createdAt: NOW - 3000 }),
        decision({ subjectId: 'd', status: 'pending', tier: 'escalated', createdAt: NOW - 2000 }),
        decision({ subjectId: 'e', status: 'failed', tier: 'applied', createdAt: NOW - 1000 }),
      ],
    })
    expect(summarise(w).supervisor).toEqual({
      applied: 2,
      pending: 2,
      escalated: 1,
      failed: 1,
      lastDecisionAt: NOW - 1000,
    })
  })

  it('reports no last decision when the workspace has never been supervised', () => {
    expect(summarise(world()).supervisor).toEqual({
      applied: 0,
      pending: 0,
      escalated: 0,
      failed: 0,
      lastDecisionAt: null,
    })
  })

  it('takes lastDecisionAt from the newest decision whatever order they arrive in', () => {
    const w = world({
      decisions: [
        decision({ subjectId: 'a', createdAt: NOW - 1000 }),
        decision({ subjectId: 'b', createdAt: NOW - 9000 }),
      ],
    })
    expect(summarise(w).supervisor.lastDecisionAt).toBe(NOW - 1000)
  })
})
