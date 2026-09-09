import { describe, expect, it } from 'vitest'
import type { Action, Candidate, Tier } from '../../src/supervisor/actions.js'
import { answerTier, chooseByRules, tierOf } from '../../src/supervisor/policy.js'
import { question, slave, task, world } from './fixtures.js'

const RUNNING = world()
const HALTED = world({ halted: { reason: 'budget_exhausted' } })

const ACTIONS: Readonly<Record<Action['kind'], Action>> = {
  unblock_task: { kind: 'unblock_task', taskId: 't1' },
  raise_max_attempts: { kind: 'raise_max_attempts', taskId: 't1' },
  set_runtime_roles: { kind: 'set_runtime_roles', slaveId: 's1', roles: ['reviewer'] },
  answer_question: { kind: 'answer_question', messageId: 'm1' },
  reassign_question: { kind: 'reassign_question', messageId: 'm1', toSlaveId: 's2' },
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
    // Both mailbox actions are `proposed` against a world that does not hold the question: the
    // catalogue's safe default, and for `answer_question` the ONLY tier `tierOf` ever gives it --
    // its final tier comes from `answerTier` alone (spec section 3).
    ['answer_question', 'proposed', 'proposed'],
    ['reassign_question', 'proposed', 'proposed'],
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
      expect(tierOf(ACTIONS.answer_question, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.mark_task_failed, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.escalate_to_human, RUNNING, kind)).toBe('escalated')
      expect(tierOf(ACTIONS.no_action, RUNNING, kind)).toBe('noop')
    }
  })
})

/**
 * The re-address tier is a fact about the WORLD, not about the action: putting a question in front
 * of somebody who cannot answer it is not routine, however well-formed the action is. `tierOf`
 * therefore looks the question and the target up rather than trusting the stored action.
 */
describe('tierOf -- reassign_question', () => {
  const reassign = (toSlaveId: string): Action => ({ kind: 'reassign_question', messageId: 'm1', toSlaveId })
  const OPS = slave({ id: 's2', name: 'Ops', role: 'Operator', runtimeRoles: ['backend'] })
  const SALES = slave({ id: 's3', name: 'Sam', role: 'Sales', runtimeRoles: ['sales'] })

  it('applies a re-address to a slave who holds the role the question was addressed to', () => {
    const w = world({ questions: [question({ recipientRole: 'backend' })], slaves: [OPS, SALES] })
    expect(tierOf(reassign('s2'), w, 'waiting_stale')).toBe('applied')
  })

  it('proposes a re-address to a slave who does not hold that role', () => {
    const w = world({ questions: [question({ recipientRole: 'backend' })], slaves: [OPS, SALES] })
    expect(tierOf(reassign('s3'), w, 'waiting_stale')).toBe('proposed')
  })

  it("applies a slave-addressed re-address to a holder of the asker task's required role", () => {
    const w = world({
      questions: [question({ recipientRole: null, recipientSlaveId: 'gone', taskId: 't1' })],
      slaves: [OPS, SALES],
      tasks: [task({ id: 't1', requiredRole: 'backend' })],
    })
    expect(tierOf(reassign('s2'), w, 'unanswerable_question')).toBe('applied')
    expect(tierOf(reassign('s3'), w, 'unanswerable_question')).toBe('proposed')
  })

  it('proposes rather than guessing when the target or the question is not in the world', () => {
    const w = world({ questions: [question({ recipientRole: 'backend' })], slaves: [OPS] })
    expect(tierOf(reassign('nobody'), w, 'waiting_stale')).toBe('proposed')
    expect(tierOf(reassign('s2'), world({ slaves: [OPS] }), 'waiting_stale')).toBe('proposed')
  })

  it('is proposed while the workspace is halted, however well the target fits', () => {
    const w = world({
      questions: [question({ recipientRole: 'backend' })],
      slaves: [OPS],
      halted: { reason: 'budget_exhausted' },
    })
    expect(tierOf(reassign('s2'), w, 'waiting_stale')).toBe('proposed')
  })
})

/**
 * The whole truth table of the ONE function an `answer_question` decision's final tier comes from
 * (spec section 5). Critical wins over everything -- a question about a secret or a spend is never
 * answered automatically, halted or not, sourced or not.
 */
describe('answerTier', () => {
  const table: [boolean, boolean, boolean, Tier][] = [
    // sourced  critical  halted   tier
    [true, false, false, 'applied'],
    [true, false, true, 'proposed'],
    [true, true, false, 'escalated'],
    [true, true, true, 'escalated'],
    [false, false, false, 'proposed'],
    [false, false, true, 'proposed'],
    [false, true, false, 'escalated'],
    [false, true, true, 'escalated'],
  ]

  it.each(table)('sourced=%s critical=%s halted=%s -> %s', (sourced, critical, halted, expected) => {
    expect(answerTier({ sourced, critical, halted })).toBe(expected)
  })

  it('never applies anything the catalogue would not have applied by itself', () => {
    // The one row that applies is the one where the answer is verified, nothing is critical and the
    // workspace is running -- so a bug that widened this table would show up as a second `applied`.
    expect(table.filter(([, , , tier]) => tier === 'applied')).toHaveLength(1)
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
      candidate(ACTIONS.reassign_question, 'applied'),
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
