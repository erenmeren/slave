import { describe, expect, it } from 'vitest'
import type { Action, Candidate, Tier } from '../../src/supervisor/actions.js'
import { chooseByRules, tierOf } from '../../src/supervisor/policy.js'
import { world } from './fixtures.js'

const RUNNING = world()
const HALTED = world({ halted: { reason: 'budget_exhausted' } })

const ACTIONS: Readonly<Record<Action['kind'], Action>> = {
  unblock_task: { kind: 'unblock_task', taskId: 't1' },
  raise_max_attempts: { kind: 'raise_max_attempts', taskId: 't1' },
  set_runtime_roles: { kind: 'set_runtime_roles', slaveId: 's1', roles: ['reviewer'] },
  nudge_answer: { kind: 'nudge_answer', messageId: 'm1' },
  mark_task_failed: { kind: 'mark_task_failed', taskId: 't1', reason: 'dead end' },
  escalate_to_human: { kind: 'escalate_to_human', summary: 'a human must look' },
  no_action: { kind: 'no_action' },
}

function candidate(action: Action, tier: Tier): Candidate {
  return { action, tier, why: 'because' }
}

describe('tierOf', () => {
  // Every row is read against `review_cap_blocked`, the one situation an `unblock_task` is routine
  // on (erratum E5); the two cases below hold the rest of that rule.
  const table: [Action['kind'], Tier, Tier][] = [
    // action kind            running    halted
    ['unblock_task', 'applied', 'proposed'],
    ['nudge_answer', 'applied', 'proposed'],
    ['raise_max_attempts', 'proposed', 'proposed'],
    ['set_runtime_roles', 'proposed', 'proposed'],
    ['mark_task_failed', 'proposed', 'proposed'],
    ['escalate_to_human', 'escalated', 'escalated'],
    ['no_action', 'noop', 'noop'],
  ]

  it.each(table)('tiers %s as %s while running and %s while halted', (kind, running, halted) => {
    expect(tierOf(ACTIONS[kind], RUNNING, 'review_cap_blocked')).toBe(running)
    expect(tierOf(ACTIONS[kind], HALTED, 'review_cap_blocked')).toBe(halted)
  })

  /**
   * Erratum E5. `blocked` means "a human must look at this" (M35), and two of its entrances are
   * deliberate operator parks -- `cancel` and the leftover-worktree refusal -- which a routine
   * unblock reversed one tick later. Only the review cap, a policy counter rather than a person,
   * keeps the routine exit.
   */
  it('makes an unblock a PROPOSAL for every stuck-task situation except the review cap', () => {
    expect(tierOf(ACTIONS.unblock_task, RUNNING, 'task_blocked_human')).toBe('proposed')
    expect(tierOf(ACTIONS.unblock_task, RUNNING, 'task_failed')).toBe('proposed')
    expect(tierOf(ACTIONS.unblock_task, RUNNING, 'review_cap_blocked')).toBe('applied')
  })

  it('leaves the other tiers alone whatever the situation kind is', () => {
    for (const kind of ['review_cap_blocked', 'task_blocked_human', 'waiting_stale'] as const) {
      expect(tierOf(ACTIONS.nudge_answer, RUNNING, kind)).toBe('applied')
      expect(tierOf(ACTIONS.mark_task_failed, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.escalate_to_human, RUNNING, kind)).toBe('escalated')
      expect(tierOf(ACTIONS.no_action, RUNNING, kind)).toBe('noop')
    }
  })
})

describe('chooseByRules', () => {
  it('picks the single routine action when the rules offer exactly one', () => {
    const cands = [
      candidate(ACTIONS.unblock_task, 'applied'),
      candidate(ACTIONS.mark_task_failed, 'proposed'),
      candidate(ACTIONS.escalate_to_human, 'escalated'),
      candidate(ACTIONS.no_action, 'noop'),
    ]
    expect(chooseByRules(cands)).toBe(0)
  })

  it('escalates when two routine actions compete -- the rules do not rank them', () => {
    const cands = [
      candidate(ACTIONS.unblock_task, 'applied'),
      candidate(ACTIONS.nudge_answer, 'applied'),
      candidate(ACTIONS.escalate_to_human, 'escalated'),
      candidate(ACTIONS.no_action, 'noop'),
    ]
    expect(chooseByRules(cands)).toBe(2)
  })

  it('escalates when no routine action is on offer', () => {
    const cands = [
      candidate(ACTIONS.set_runtime_roles, 'proposed'),
      candidate(ACTIONS.escalate_to_human, 'escalated'),
      candidate(ACTIONS.no_action, 'noop'),
    ]
    expect(chooseByRules(cands)).toBe(1)
  })

  it('does not mistake the escalation or the no-op for a routine action', () => {
    expect(chooseByRules([candidate(ACTIONS.escalate_to_human, 'escalated'), candidate(ACTIONS.no_action, 'noop')])).toBe(0)
  })

  it('escalates rather than applying a routine action a halt has downgraded', () => {
    // The same list `candidates` builds while the workspace is halted: everything is `proposed`.
    const cands = [
      candidate(ACTIONS.unblock_task, 'proposed'),
      candidate(ACTIONS.escalate_to_human, 'escalated'),
      candidate(ACTIONS.no_action, 'noop'),
    ]
    expect(chooseByRules(cands)).toBe(1)
  })

  it('refuses an empty list rather than inventing an index', () => {
    expect(() => chooseByRules([])).toThrow()
  })
})
