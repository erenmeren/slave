import { describe, expect, it } from 'vitest'
import { candidateSchema, type Action, type Candidate } from '../../src/supervisor/actions.js'
import { candidates } from '../../src/supervisor/candidates.js'
import { WAITING_STALE_MS } from '../../src/supervisor/constants.js'
import { observe } from '../../src/supervisor/observe.js'
import type { SupervisorWorld } from '../../src/supervisor/world.js'
import { NOW, question, slave, task, world } from './fixtures.js'

/** The one situation `w` produces, with the candidates the rules offer for it. */
function offered(w: SupervisorWorld): readonly Candidate[] {
  const situations = observe(w)
  expect(situations).toHaveLength(1)
  return candidates(situations[0]!, w)
}

function kinds(cands: readonly Candidate[]): Action['kind'][] {
  return cands.map((c) => c.action.kind)
}

describe('candidates -- the shape every list shares', () => {
  it('always ends with escalate_to_human then no_action, and is never empty', () => {
    const worlds: SupervisorWorld[] = [
      world({ tasks: [task({ status: 'reviewing' })] }),
      world({ goal: 'Ship it' }),
      world({ tasks: [task({ status: 'blocked' })] }),
      world({ tasks: [task({ status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted' })] }),
      world({ tasks: [task({ status: 'failed', dependents: 1 })] }),
      world({ questions: [question({ createdAt: NOW - WAITING_STALE_MS - 1 })], slaves: [slave()] }),
      world({ questions: [question({ recipientRole: 'security' })] }),
      world({ tasks: [task({ status: 'ready', requiredRole: 'frontend' })] }),
      world({ tasks: [task({ status: 'done', dependents: 1, statusSince: 0 })] }),
      world({ halted: { reason: 'budget_exhausted' } }),
    ]
    for (const w of worlds) {
      const cands = offered(w)
      expect(cands.length).toBeGreaterThan(0)
      expect(kinds(cands).slice(-2)).toEqual(['escalate_to_human', 'no_action'])
      expect(cands.every((c) => c.why.length > 0)).toBe(true)
    }
  })

  it('offers candidates that survive candidateSchema, the validator that reads them back off the row', () => {
    const w = world({
      tasks: [task({ status: 'blocked' })],
      slaves: [slave({ id: 's1', role: 'QA Reviewer', runtimeRoles: ['qa'] })],
    })
    for (const situation of observe(w)) {
      for (const candidate of candidates(situation, w)) {
        expect(candidateSchema.safeParse(candidate).success, `${candidate.action.kind} did not validate`).toBe(true)
      }
    }
  })

  it('stamps each candidate with the tier the policy gives its action IN THIS SITUATION', () => {
    // A `blocked` task with no guardrail behind it is `task_blocked_human` -- a person parked it,
    // so the unblock is a proposal (erratum E5).
    expect(offered(world({ tasks: [task({ status: 'blocked' })] })).map((c) => [c.action.kind, c.tier])).toEqual([
      ['unblock_task', 'proposed'],
      ['mark_task_failed', 'proposed'],
      ['escalate_to_human', 'escalated'],
      ['no_action', 'noop'],
    ])
    // The same action, the same world shape, one guardrail different: the review cap is a policy
    // counter, and going back to rework is what the counter was for.
    expect(
      offered(world({ tasks: [task({ status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted' })] })).map(
        (c) => [c.action.kind, c.tier],
      ),
    ).toEqual([
      ['unblock_task', 'applied'],
      ['mark_task_failed', 'proposed'],
      ['escalate_to_human', 'escalated'],
      ['no_action', 'noop'],
    ])
  })
})

describe('candidates -- blocked tasks', () => {
  it('offers unblock_task while attempts remain', () => {
    const cands = offered(world({ tasks: [task({ status: 'blocked', attempt: 1, maxAttempts: 3 })] }))
    expect(kinds(cands)).toEqual(['unblock_task', 'mark_task_failed', 'escalate_to_human', 'no_action'])
    expect(cands[0]?.action).toEqual({ kind: 'unblock_task', taskId: 't1' })
  })

  it('offers raise_max_attempts instead once the task is at its cap', () => {
    const cands = offered(world({ tasks: [task({ status: 'blocked', attempt: 3, maxAttempts: 3 })] }))
    expect(kinds(cands)).toEqual(['raise_max_attempts', 'mark_task_failed', 'escalate_to_human', 'no_action'])
    expect(cands[0]?.action).toEqual({ kind: 'raise_max_attempts', taskId: 't1' })
  })

  it('offers the same two exits for a task parked at the review cap', () => {
    const w = world({ tasks: [task({ status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted', attempt: 1 })] })
    expect(kinds(offered(w))).toEqual(['unblock_task', 'mark_task_failed', 'escalate_to_human', 'no_action'])
  })

  it('gives mark_task_failed a reason a human can read back', () => {
    const cands = offered(world({ tasks: [task({ status: 'blocked' })] }))
    const failed = cands.find((c) => c.action.kind === 'mark_task_failed')?.action
    expect(failed?.kind === 'mark_task_failed' && failed.reason.length > 0).toBe(true)
  })
})

describe('candidates -- task_failed', () => {
  it('offers only the escalation: no verb re-opens a failed task', () => {
    const cands = offered(world({ tasks: [task({ status: 'failed', dependents: 2 })] }))
    expect(kinds(cands)).toEqual(['escalate_to_human', 'no_action'])
  })
})

describe('candidates -- the staffing situations', () => {
  it('offers set_runtime_roles adding reviewer to each non-busy slave, keeping the roles it has', () => {
    const w = world({
      tasks: [task({ status: 'reviewing' })],
      slaves: [
        slave({ id: 's1', role: 'Backend Engineer', runtimeRoles: ['backend'] }),
        slave({ id: 's2', role: 'QA Reviewer', runtimeRoles: ['qa'] }),
      ],
    })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['set_runtime_roles', 'set_runtime_roles', 'escalate_to_human', 'no_action'])
    // "QA Reviewer" contains "reviewer" -- the likeliest holder is offered first (spec §3).
    expect(cands[0]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's2', roles: ['qa', 'reviewer'] })
    expect(cands[1]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's1', roles: ['backend', 'reviewer'] })
  })

  it('skips busy slaves and offers at most three', () => {
    const w = world({
      tasks: [task({ status: 'reviewing' })],
      slaves: [
        slave({ id: 's1', role: 'A', runtimeRoles: ['backend'] }),
        slave({ id: 's2', role: 'B', runtimeRoles: ['backend'] }),
        slave({ id: 's3', role: 'C', runtimeRoles: ['backend'], busy: true }),
        slave({ id: 's4', role: 'D', runtimeRoles: ['backend'] }),
        slave({ id: 's5', role: 'E', runtimeRoles: ['backend'] }),
      ],
    })
    const cands = offered(w)
    const staffing = cands.filter((c) => c.action.kind === 'set_runtime_roles')
    expect(staffing).toHaveLength(3)
    expect(staffing.map((c) => (c.action.kind === 'set_runtime_roles' ? c.action.slaveId : ''))).toEqual(['s1', 's2', 's4'])
  })

  it('falls back to the escalation alone when there is nobody to staff', () => {
    const w = world({ tasks: [task({ status: 'reviewing' })], slaves: [slave({ busy: true })] })
    expect(kinds(offered(w))).toEqual(['escalate_to_human', 'no_action'])
  })

  it('offers manager for no_planner and the required role for ready_unstaffed', () => {
    const planner = world({ goal: 'Ship it', slaves: [slave({ id: 's1', role: 'Team Lead', runtimeRoles: ['backend'] })] })
    expect(offered(planner)[0]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's1', roles: ['backend', 'manager'] })

    const unstaffed = world({
      tasks: [task({ status: 'ready', requiredRole: 'frontend' })],
      slaves: [slave({ id: 's1', role: 'Backend Engineer', runtimeRoles: ['backend'] })],
    })
    expect(offered(unstaffed)[0]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's1', roles: ['backend', 'frontend'] })
  })
})

describe('candidates -- questions', () => {
  it('offers nudge_answer for a stale question', () => {
    const w = world({ questions: [question({ createdAt: NOW - WAITING_STALE_MS - 1 })], slaves: [slave()] })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['nudge_answer', 'escalate_to_human', 'no_action'])
    expect(cands[0]?.action).toEqual({ kind: 'nudge_answer', messageId: 'm1' })
  })

  it('offers nudge_answer for an unanswerable question too', () => {
    const w = world({ questions: [question({ recipientRole: 'security' })] })
    expect(kinds(offered(w))).toEqual(['nudge_answer', 'escalate_to_human', 'no_action'])
  })
})

describe('candidates -- the escalate-only situations', () => {
  it('offers only the escalation for a stale unintegrated task and for a halted workspace', () => {
    const stale = world({ tasks: [task({ status: 'done', dependents: 1, statusSince: 0 })] })
    expect(kinds(offered(stale))).toEqual(['escalate_to_human', 'no_action'])

    const halted = world({ halted: { reason: 'budget_exhausted' } })
    expect(kinds(offered(halted))).toEqual(['escalate_to_human', 'no_action'])
  })

  it("carries the situation's summary into the escalation so a human sees what it is about", () => {
    const halted = world({ halted: { reason: 'budget_exhausted' } })
    const escalation = offered(halted)[0]?.action
    expect(escalation?.kind === 'escalate_to_human' && escalation.summary).toContain('budget_exhausted')
  })
})
