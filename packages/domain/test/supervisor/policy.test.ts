import { describe, expect, it } from 'vitest'
import type { Action, Candidate, Tier } from '../../src/supervisor/actions.js'
import { answerBar, answerTier, chooseByRules, mayAnswer, tierOf } from '../../src/supervisor/policy.js'
import { SITUATION_KINDS } from '../../src/supervisor/situations.js'
import { question, slave, task, world } from './fixtures.js'

const RUNNING = world()
const HALTED = world({ halted: { reason: 'budget_exhausted' } })

const ACTIONS: Readonly<Record<Action['kind'], Action>> = {
  unblock_task: { kind: 'unblock_task', taskId: 't1' },
  raise_max_attempts: { kind: 'raise_max_attempts', taskId: 't1' },
  set_runtime_roles: { kind: 'set_runtime_roles', slaveId: 's1', roles: ['reviewer'] },
  assign_capability: {
    kind: 'assign_capability',
    slaveId: 's1',
    capability: 'security.application',
    capabilityLabel: 'Application security',
    role: 'security',
  },
  materialise_company_worker: {
    kind: 'materialise_company_worker',
    companySlaveId: 'cs1',
    capability: 'security.application',
    capabilityLabel: 'Application security',
    name: 'Sam',
    rationale: 'Sam is already on the company roster and provides Application security.',
  },
  hire_from_catalog: {
    kind: 'hire_from_catalog',
    templateId: 'tpl1',
    capability: 'security.application',
    capabilityLabel: 'Application security',
    name: 'Security Reviewer',
    rationale: 'nobody here provides Application security',
    temporary: false,
  },
  adopt_runbook: {
    kind: 'adopt_runbook',
    runbookId: 'rb1',
    key: 'feature-delivery',
    name: 'Feature delivery',
    rationale: 'The goal says "ship".',
  },
  answer_question: { kind: 'answer_question', messageId: 'm1' },
  reassign_question: { kind: 'reassign_question', messageId: 'm1', toSlaveId: 's2' },
  mark_task_failed: { kind: 'mark_task_failed', taskId: 't1', reason: 'dead end' },
  cancel_task: { kind: 'cancel_task', taskId: 't1', reason: 'the new goal no longer needs it' },
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
    // M47 R4. The routine one of the three: the worker's own row is the evidence, the role granted
    // is the one the capability projects to by definition, and nobody new arrives.
    ['assign_capability', 'applied', 'proposed'],
    // A roster is a person's decision and a hire is a commitment -- never automatic.
    ['materialise_company_worker', 'proposed', 'proposed'],
    ['hire_from_catalog', 'proposed', 'proposed'],
    // M48 R5: a way of working is a person's decision, exactly as a hire is.
    ['adopt_runbook', 'proposed', 'proposed'],
    ['mark_task_failed', 'proposed', 'proposed'],
    // M40 ruling R1: a cancellation is never automatic -- a wrong deletion costs real planned work.
    ['cancel_task', 'proposed', 'proposed'],
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

  // The tier of a cancellation is the one thing about it that must not depend on anything: not the
  // situation it was offered for, not whether the workspace is halted, not the task's own state.
  it('tiers cancel_task as a PROPOSAL for every situation kind, running or halted', () => {
    for (const kind of SITUATION_KINDS) {
      expect(tierOf(ACTIONS.cancel_task, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.cancel_task, HALTED, kind)).toBe('proposed')
    }
  })

  // M47 R4: every one of the three is a PROPOSAL while the workspace is halted -- the short-circuit
  // above the switch already does it, and this is what says so. A halt is a guardrail's verdict
  // that this project should not be moving, and "routine" does not survive it.
  it('proposes all three capability actions while the workspace is halted, for every situation kind', () => {
    for (const kind of SITUATION_KINDS) {
      expect(tierOf(ACTIONS.assign_capability, HALTED, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.materialise_company_worker, HALTED, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.hire_from_catalog, HALTED, kind)).toBe('proposed')
    }
  })

  // M48 R5: nothing about the situation it was offered for, and nothing about a halt, can make
  // adopting a way of working automatic -- there is no evidence on any row that says this project
  // should follow this process.
  it('tiers adopt_runbook as a PROPOSAL for every situation kind, running or halted', () => {
    for (const kind of SITUATION_KINDS) {
      expect(tierOf(ACTIONS.adopt_runbook, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.adopt_runbook, HALTED, kind)).toBe('proposed')
    }
  })

  it('applies an assign_capability whatever situation it was offered for, and never a hire', () => {
    for (const kind of SITUATION_KINDS) {
      expect(tierOf(ACTIONS.assign_capability, RUNNING, kind)).toBe('applied')
      expect(tierOf(ACTIONS.materialise_company_worker, RUNNING, kind)).toBe('proposed')
      expect(tierOf(ACTIONS.hire_from_catalog, RUNNING, kind)).toBe('proposed')
    }
  })

  /**
   * Fix round 1, Important 2. R4's first offer is the IDLE worker who already provides the
   * capability, and `staffableSlaves` has refused to offer a role change on a busy worker since
   * M38 for the same reason: its run is in flight and its roles must not move under it.
   * `formTeam` only SORTS idle-first, so the sole provider of a capability can be busy and the
   * offer is still made -- rightly, a human may approve it. What must not happen is a tick
   * applying it by itself.
   */
  it('proposes rather than applies an assign_capability whose worker is busy', () => {
    const busy = world({ slaves: [slave({ id: 's1', busy: true })] })
    const idle = world({ slaves: [slave({ id: 's1', busy: false })] })
    expect(tierOf(ACTIONS.assign_capability, busy, 'capability_unstaffed')).toBe('proposed')
    expect(tierOf(ACTIONS.assign_capability, idle, 'capability_unstaffed')).toBe('applied')
  })

  it('applies an assign_capability naming a worker the world no longer holds, as the union it is', () => {
    // Not a guess about a stranger: `applyDecision` re-reads the row and refuses `slave_not_found`
    // if the worker really is gone, and a `proposed` here would park every offer made against a
    // roster the world had not finished loading.
    expect(tierOf(ACTIONS.assign_capability, world({ slaves: [] }), 'capability_unstaffed')).toBe('applied')
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
 * The rule both sides share (final review Important 3). Control's `reassignQuestion` calls
 * `answerBar` too, so the cases here are the cases the write gate refuses -- there is no second
 * spelling of the rule that can drift from this one.
 */
describe('answerBar / mayAnswer', () => {
  const ASKER = slave({ id: 's1', name: 'Alex', runtimeRoles: ['backend'] })
  const OPS = slave({ id: 's2', name: 'Ops', runtimeRoles: ['backend'] })

  /**
   * Erratum E8. The asker holds the asking task's role by construction -- it is doing the task it
   * asked about -- so every other clause of the rule waves it through, and a question re-addressed
   * to whoever asked it is a loop `answer.ts` refuses to close: the asker stays parked forever.
   * This clause was in control alone until now, and the domain's agreement rested on a filter in
   * `candidates` happening to exclude it as well.
   */
  it('never permits the ASKER, however many of the roles it holds', () => {
    const w = world({ questions: [question({ recipientRole: 'backend' })], slaves: [ASKER, OPS] })
    const q = question({ recipientRole: 'backend' })
    expect(mayAnswer(q, ASKER, w)).toBe(false)
    expect(mayAnswer(q, OPS, w)).toBe(true)
    expect(answerBar({ askerSlaveId: 's1', recipientRole: 'backend', taskRequiredRole: 'backend' }, ASKER)).toBe('asker')
  })

  it('refuses the asker on the slave-addressed branch too, where no role is checked at all', () => {
    const w = world({ questions: [], slaves: [ASKER], tasks: [task({ id: 't1', requiredRole: '' })] })
    const q = question({ recipientRole: null, recipientSlaveId: 's9', taskId: 't1' })
    // The empty `requiredRole` is the "any role will do" case, which permits everybody else.
    expect(mayAnswer(q, ASKER, w)).toBe(false)
    expect(mayAnswer(q, OPS, w)).toBe(true)
  })

  it('names WHICH bar stopped a worker, so control can say it in a sentence', () => {
    expect(answerBar({ askerSlaveId: 's1', recipientRole: 'backend', taskRequiredRole: null }, OPS)).toBe(null)
    expect(
      answerBar({ askerSlaveId: 's1', recipientRole: 'qa', taskRequiredRole: null }, OPS),
    ).toBe('recipient_role')
    expect(
      answerBar({ askerSlaveId: 's1', recipientRole: null, taskRequiredRole: 'qa' }, OPS),
    ).toBe('task_role')
    // No task, and a task that takes any role at all, leave nothing to check.
    expect(answerBar({ askerSlaveId: 's1', recipientRole: null, taskRequiredRole: null }, OPS)).toBe(null)
    expect(answerBar({ askerSlaveId: 's1', recipientRole: null, taskRequiredRole: '' }, OPS)).toBe(null)
  })

  it('is the rule tierOf stamps a re-address with -- an asker target is never routine', () => {
    const w = world({ questions: [question({ recipientRole: 'backend' })], slaves: [ASKER, OPS] })
    const reassign = (toSlaveId: string): Action => ({ kind: 'reassign_question', messageId: 'm1', toSlaveId })
    expect(tierOf(reassign('s1'), w, 'waiting_stale')).toBe('proposed')
    expect(tierOf(reassign('s2'), w, 'waiting_stale')).toBe('applied')
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
