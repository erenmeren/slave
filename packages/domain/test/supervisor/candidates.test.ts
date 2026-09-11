import { describe, expect, it } from 'vitest'
import { candidateSchema, type Action, type Candidate } from '../../src/supervisor/actions.js'
import { candidates, isStaffableTask, teamPlanOf } from '../../src/supervisor/candidates.js'
import { WAITING_STALE_MS } from '../../src/supervisor/constants.js'
import { observe } from '../../src/supervisor/observe.js'
import type { Situation } from '../../src/supervisor/situations.js'
import type { SupervisorWorld } from '../../src/supervisor/world.js'
import { NOW, TAXONOMY, question, runbook, slave, task, world } from './fixtures.js'

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
    // Two worlds, because one cannot hold both a blocked task and a question situation without the
    // second hiding the first: the task world covers the task actions, the question world covers
    // the two the M39 catalogue added.
    const taskWorld = world({
      tasks: [task({ status: 'blocked' })],
      slaves: [slave({ id: 's1', role: 'QA Reviewer', runtimeRoles: ['qa'] })],
    })
    const questionWorld = world({
      questions: [
        question({
          createdAt: NOW - WAITING_STALE_MS - 1,
          askerSlaveId: 's9',
          recipientRole: 'backend',
          holders: ['s1', 's2'],
        }),
      ],
      slaves: [
        slave({ id: 's1', name: 'Alex', runtimeRoles: ['backend'], busy: true }),
        slave({ id: 's2', name: 'Ops', runtimeRoles: ['backend'] }),
        slave({ id: 's9', name: 'Maya', role: 'Product', runtimeRoles: ['product'] }),
      ],
    })
    const seen = new Set<string>()
    for (const w of [taskWorld, questionWorld]) {
      for (const situation of observe(w)) {
        for (const candidate of candidates(situation, w)) {
          seen.add(candidate.action.kind)
          expect(candidateSchema.safeParse(candidate).success, `${candidate.action.kind} did not validate`).toBe(true)
        }
      }
    }
    expect(seen.has('answer_question') && seen.has('reassign_question')).toBe(true)
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

  it('ranks by the title with a mixed-case requiredRole, not only a lowercase one', () => {
    // `requiredRole` is free text an operator typed. Lowercasing only the TITLE side made `QA`
    // match no title at all, so the ranking silently collapsed to slave-id order and the obvious
    // holder stopped being offered first (final review Minor 7). `s1` sorts before `s2` by id, so
    // this test can only pass because the title matched.
    const w = world({
      tasks: [task({ status: 'ready', requiredRole: 'QA' })],
      slaves: [
        slave({ id: 's1', role: 'Backend Engineer', runtimeRoles: ['backend'] }),
        slave({ id: 's2', role: 'QA Engineer', runtimeRoles: ['backend'] }),
      ],
    })
    const cands = offered(w)
    expect(cands[0]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's2', roles: ['backend', 'QA'] })
    expect(cands[1]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's1', roles: ['backend', 'QA'] })
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

/**
 * Every world here is one Task 3's loader could really produce, and `holders` is filled by the
 * loader contract in `world.ts` rather than by whatever would make the case pass: for a
 * ROLE-addressed question, every holder of that role; for a SLAVE-addressed one, the addressed
 * slave plus every holder of the asker task's `requiredRole`. The asker is always a third slave --
 * a question addressed to the slave who asked it is not a state M36 can create.
 */
describe('candidates -- questions', () => {
  const STALE = NOW - WAITING_STALE_MS - 1
  const BUSY_HOLDER = slave({ id: 's1', name: 'Alex', runtimeRoles: ['backend'], busy: true })
  const IDLE_HOLDER = slave({ id: 's2', name: 'Ops', role: 'Operator', runtimeRoles: ['backend'], busy: false })
  const ASKER = slave({ id: 's9', name: 'Maya', role: 'Product Owner', runtimeRoles: ['product'] })
  /** The asking task, whose `requiredRole` is what makes a peer a holder of a slave-addressed
   *  question (the loader contract's second limb). */
  const ASKING_TASK = task({ id: 't1', requiredRole: 'backend' })

  it('offers an answer first for a stale question, and it is never routine on its own', () => {
    const w = world({ questions: [question({ createdAt: STALE })], slaves: [slave()] })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['answer_question', 'escalate_to_human', 'no_action'])
    expect(cands[0]?.action).toEqual({ kind: 'answer_question', messageId: 'm1' })
    expect(cands[0]?.tier).toBe('proposed')
  })

  it('offers a re-address to an idle holder of the role when the question has waited', () => {
    // The reachable case: Maya asked the "backend" role, Alex holds it and is busy, Ops holds it
    // and is not. Role-addressed, so `holders` is exactly the two backend holders.
    const w = world({
      questions: [question({ createdAt: STALE, askerSlaveId: 's9', recipientRole: 'backend', holders: ['s1', 's2'] })],
      slaves: [BUSY_HOLDER, IDLE_HOLDER, ASKER],
      tasks: [ASKING_TASK],
    })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['answer_question', 'reassign_question', 'escalate_to_human', 'no_action'])
    expect(cands[1]?.action).toEqual({ kind: 'reassign_question', messageId: 'm1', toSlaveId: 's2' })
    expect(cands[1]?.tier).toBe('applied')
    expect(cands[1]?.why).toContain('Ops')
  })

  it('offers a re-address to a task-role peer when the addressed slave cannot take it', () => {
    // Slave-addressed to Alex, who is busy. `holders` is Alex plus the holders of the asking task's
    // required role -- which is how Ops, whom the question never named, is allowed to answer it.
    const w = world({
      questions: [
        question({
          createdAt: STALE,
          askerSlaveId: 's9',
          recipientSlaveId: 's1',
          recipientRole: null,
          holders: ['s1', 's2'],
        }),
      ],
      slaves: [BUSY_HOLDER, IDLE_HOLDER, ASKER],
      tasks: [ASKING_TASK],
    })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['answer_question', 'reassign_question', 'escalate_to_human', 'no_action'])
    expect(cands[1]?.action).toEqual({ kind: 'reassign_question', messageId: 'm1', toSlaveId: 's2' })
    expect(cands[1]?.tier).toBe('applied')
  })

  it('does not re-address a question whose addressed slave is sitting there idle', () => {
    const w = world({
      questions: [
        question({
          createdAt: STALE,
          askerSlaveId: 's9',
          recipientSlaveId: 's1',
          recipientRole: null,
          holders: ['s1', 's2'],
        }),
      ],
      slaves: [slave({ id: 's1', name: 'Alex', runtimeRoles: ['backend'], busy: false }), IDLE_HOLDER, ASKER],
      tasks: [ASKING_TASK],
    })
    expect(kinds(offered(w))).toEqual(['answer_question', 'escalate_to_human', 'no_action'])
  })

  it('re-addresses only to a slave who could actually answer -- an idle stranger is not offered', () => {
    const w = world({
      questions: [question({ createdAt: STALE, askerSlaveId: 's9', recipientRole: 'backend', holders: ['s1'] })],
      slaves: [BUSY_HOLDER, slave({ id: 's3', name: 'Sam', role: 'Sales', runtimeRoles: ['sales'] }), ASKER],
      tasks: [ASKING_TASK],
    })
    expect(kinds(offered(w))).toEqual(['answer_question', 'escalate_to_human', 'no_action'])
  })

  it('never re-addresses a question back to the slave who asked it', () => {
    // Ops asked the "backend" role a question and holds it herself; Alex, the only other holder, is
    // busy. There is nobody left to re-address to, and Ops is not it.
    const w = world({
      questions: [question({ createdAt: STALE, askerSlaveId: 's2', recipientRole: 'backend', holders: ['s1', 's2'] })],
      slaves: [BUSY_HOLDER, IDLE_HOLDER],
      tasks: [ASKING_TASK],
    })
    expect(kinds(offered(w))).toEqual(['answer_question', 'escalate_to_human', 'no_action'])
  })

  it('keeps the staffing offers after the answer for an unanswerable question', () => {
    const w = world({ questions: [question({ recipientRole: 'security' })], slaves: [slave()] })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['answer_question', 'set_runtime_roles', 'escalate_to_human', 'no_action'])
    expect(cands[1]?.action).toEqual({ kind: 'set_runtime_roles', slaveId: 's1', roles: ['backend', 'security'] })
  })

  it('offers a re-address for a question whose named slave has left, when somebody else can take it', () => {
    // A departed slave is never a holder, so `holders` is the task-role peers alone -- which is the
    // only reason this question is answerable by anybody at all.
    const w = world({
      questions: [
        question({ askerSlaveId: 's9', recipientRole: null, recipientSlaveId: 'gone', holders: ['s2'], taskId: 't1' }),
      ],
      slaves: [IDLE_HOLDER, ASKER],
      tasks: [ASKING_TASK],
    })
    const cands = offered(w)
    expect(kinds(cands)).toEqual(['answer_question', 'reassign_question', 'escalate_to_human', 'no_action'])
    expect(cands[1]?.action).toEqual({ kind: 'reassign_question', messageId: 'm1', toSlaveId: 's2' })
    expect(cands[1]?.tier).toBe('applied')
  })

  it('offers nothing but the last resorts when the world no longer holds the question', () => {
    // `observe` only ever names a question the world has, so this is a defensive shape rather than
    // a state a tick can reach -- but a catalogue that indexed into `undefined` would throw inside
    // the decider, and an empty list would break `chooseByRules`.
    const w = world({ questions: [question({ createdAt: STALE })], slaves: [slave()] })
    const situation = observe(w)[0]!
    expect(kinds(candidates(situation, world({ slaves: [slave()] })))).toEqual(['escalate_to_human', 'no_action'])
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

/**
 * M40 §3. `stale_task` is the one situation `observe` never produces -- `concludeReplan` records it
 * from a re-plan run's delta -- so every case here builds the {@link Situation} by hand, the way
 * the orchestrator does, rather than through {@link offered}.
 */
describe('candidates -- stale_task', () => {
  function staleTask(taskId = 't1'): Situation {
    return {
      kind: 'stale_task',
      subjectId: taskId,
      summary: `The re-plan for goal v2 no longer needs "Add the thing".`,
      facts: { goalVersion: 1, currentVersion: 2, reason: 'replan_cancel' },
    }
  }

  it('offers cancel_task first, then the two last resorts', () => {
    const w = world({ goalVersion: 2, tasks: [task({ id: 't1', status: 'backlog', goalVersion: 1 })] })
    const cands = candidates(staleTask(), w)
    expect(kinds(cands)).toEqual(['cancel_task', 'escalate_to_human', 'no_action'])
    expect(cands[0]?.action).toEqual({
      kind: 'cancel_task',
      taskId: 't1',
      reason: 'The re-plan for goal v2 no longer needs "Add the thing".',
    })
    expect(cands[0]?.why).toContain('Add the thing')
  })

  it('stamps cancel_task proposed -- never applied, whatever the workspace is doing (ruling R1)', () => {
    const running = world({ goalVersion: 2, tasks: [task({ id: 't1', status: 'backlog', goalVersion: 1 })] })
    expect(candidates(staleTask(), running)[0]?.tier).toBe('proposed')

    const halted = world({
      goalVersion: 2,
      halted: { reason: 'budget_exhausted' },
      tasks: [task({ id: 't1', status: 'backlog', goalVersion: 1 })],
    })
    expect(candidates(staleTask(), halted)[0]?.tier).toBe('proposed')
  })

  it('offers nothing but the last resorts when the world no longer holds the task', () => {
    expect(kinds(candidates(staleTask('gone'), world({ goalVersion: 2 })))).toEqual([
      'escalate_to_human',
      'no_action',
    ])
  })

  it('produces candidates that validate against candidateSchema', () => {
    const w = world({ goalVersion: 2, tasks: [task({ id: 't1', status: 'backlog', goalVersion: 1 })] })
    for (const candidate of candidates(staleTask(), w)) {
      expect(candidateSchema.safeParse(candidate).success).toBe(true)
    }
  })

  it('is never produced by observe, however far behind the board is', () => {
    const w = world({
      goalVersion: 5,
      tasks: [task({ id: 't1', status: 'backlog', goalVersion: 1 }), task({ id: 't2', status: 'ready', goalVersion: 1 })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(observe(w).map((situation) => situation.kind)).not.toContain('stale_task')
  })
})

describe('candidates -- capability_unstaffed (M47 R4)', () => {
  const situation: Situation = {
    kind: 'capability_unstaffed',
    subjectId: 'security.application',
    summary: 's',
    facts: { capability: 'security.application', role: 'security' },
  }

  it('offers the idle worker who already provides it, routinely, before anything else', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ id: 's1', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'] })],
      company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action).toEqual({
      kind: 'assign_capability',
      slaveId: 's1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      role: 'security',
    })
    expect(offers[0]?.tier).toBe('applied')
    expect(offers[0]?.why).toContain('Application security')
  })

  it('offers the company worker as a PROPOSAL when nobody on the project provides it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    // Fix round 1, Minor 5: the rationale travels ON the action, because it is what is stored on
    // the worker as `selectionRationale` -- "why selected", read months later by a person. The
    // capability KEY is not that sentence.
    expect(offers[0]?.action).toEqual({
      kind: 'materialise_company_worker',
      companySlaveId: 'cs1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      name: 'Sam',
      rationale: expect.stringContaining('Application security'),
    })
    expect(offers[0]?.tier).toBe('proposed')
  })

  // Fix round 1, Important 2: the offer stands -- a human may still approve it -- but a tick must
  // not write a new runtime role onto a worker whose run is in flight.
  it('proposes rather than applies the existing-worker offer when that worker is busy', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ id: 's1', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'], busy: true })],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action.kind).toBe('assign_capability')
    expect(offers[0]?.tier).toBe('proposed')
  })

  it('offers the catalog hire last, with the rationale a person reads, and never applies it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action).toEqual({
      kind: 'hire_from_catalog',
      templateId: 'tpl1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      name: 'Security Reviewer',
      rationale: expect.stringContaining('Application security'),
      temporary: false,
    })
    expect(offers[0]?.tier).toBe('proposed')
  })

  // The invariant the whole of M38 is built on, restated for the new kind.
  it('always ends with escalate_to_human then no_action, even with nothing to offer', () => {
    const offers = candidates(situation, world({ taxonomy: TAXONOMY }))
    expect(offers.map((offer) => offer.action.kind)).toEqual(['escalate_to_human', 'no_action'])
  })

  it('produces candidates that validate against candidateSchema', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ id: 's1', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'] })],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    for (const offer of candidates(situation, w)) expect(candidateSchema.safeParse(offer).success).toBe(true)
  })

  // E9: the four existing staffing arms are untouched, and gate:m38 answers index 0.
  it('leaves no_reviewer offering exactly the M38 staffing candidates', () => {
    const w = world({ tasks: [task({ status: 'reviewing' })], slaves: [slave({ runtimeRoles: ['backend'] })] })
    const offers = candidates({ kind: 'no_reviewer', subjectId: 'reviewer', summary: 's', facts: { role: 'reviewer' } }, w)
    expect(offers[0]?.action.kind).toBe('set_runtime_roles')
    expect(offers).toHaveLength(3)
  })
})

describe('isStaffableTask (M47 final review, Important 2)', () => {
  it('is the situation predicate: ready, with its dependencies integrated', () => {
    expect(isStaffableTask(task({ status: 'ready', dependenciesDone: true }))).toBe(true)
    expect(isStaffableTask(task({ status: 'ready', dependenciesDone: false }))).toBe(false)
    for (const status of ['backlog', 'blocked', 'running', 'reviewing', 'done', 'failed'] as const) {
      expect(isStaffableTask(task({ status, dependenciesDone: true })), status).toBe(false)
    }
  })
})

describe('teamPlanOf (M47 R4)', () => {
  it('reads the board\'s startable tasks and nothing else', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't1', status: 'ready', requiredCapabilities: ['security.application'] }),
        task({ id: 't2', status: 'ready', requiredCapabilities: ['backend.api-design'] }),
        task({ id: 't3', status: 'done', requiredCapabilities: ['qa.test-automation'] }),
      ],
      slaves: [slave({ id: 's1', runtimeRoles: ['backend'] })],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const plan = teamPlanOf(w)
    expect(plan.covered).toEqual([{ capability: 'backend.api-design', by: 's1' }])
    expect(plan.proposals.map((one) => one.pick.id)).toEqual(['tpl1'])
    expect(plan.unfillable).toEqual([])
  })

  // Final review, Important 2: `teamPlanOf` used to read `ready || blocked` while `observe` read
  // `ready && dependenciesDone`, so a BLOCKED task's capability produced a proposal nobody would
  // ever be asked to approve -- there was no situation to hang it on -- and the Organization page
  // showed a need row for work that is waiting on a human, not on a specialist.
  it('is not a staffing need while the task is blocked or waiting on a dependency', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't1', status: 'blocked', requiredCapabilities: ['security.application'] }),
        task({ id: 't2', status: 'ready', dependenciesDone: false, requiredCapabilities: ['backend.api-design'] }),
      ],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const plan = teamPlanOf(w)
    expect(plan.proposals).toEqual([])
    expect(plan.covered).toEqual([])
    expect(plan.unfillable).toEqual([])
    expect(observe(w).map((situation) => situation.kind)).not.toContain('capability_unstaffed')
  })

  // Fix round 1 of Task 1: one worker with two gaps is ONE proposal covering both, and each
  // situation looks itself up by `covers`.
  it('offers the same grouped proposal to each capability it covers', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application', 'backend.api-design'] })],
      slaves: [
        slave({ id: 's1', name: 'Rae', capabilities: ['security.application', 'backend.api-design'], runtimeRoles: [] }),
      ],
    })
    expect(teamPlanOf(w).proposals).toHaveLength(1)
    for (const key of ['security.application', 'backend.api-design']) {
      const offers = candidates({ kind: 'capability_unstaffed', subjectId: key, summary: 's', facts: { capability: key } }, w)
      expect(offers[0]?.action).toEqual({
        kind: 'assign_capability',
        slaveId: 's1',
        capability: key,
        capabilityLabel: key === 'security.application' ? 'Application security' : 'API design',
        role: key === 'security.application' ? 'security' : 'backend',
      })
    }
  })
})


describe('runbook_recommended offers (M48 R5)', () => {
  it('offers adopt_runbook for each recommendation, proposed, before the two last resorts', () => {
    const runbooks = [
      runbook({ key: 'feature-delivery', name: 'Feature delivery', keywords: ['ship'] }),
      runbook({ key: 'bug-fix', name: 'Bug fix', keywords: ['ship'] }),
    ]
    const w = world({ goal: 'Ship the endpoint', tasks: [], runbooks })
    const situation = observe(w).find((s) => s.kind === 'runbook_recommended')
    expect(situation).toBeDefined()
    if (situation === undefined) return
    const offers = candidates(situation, w)
    expect(offers.map((o) => o.action.kind)).toEqual(['adopt_runbook', 'adopt_runbook', 'escalate_to_human', 'no_action'])
    expect(offers[0]?.tier).toBe('proposed')
    expect(offers[0]?.action).toMatchObject({ kind: 'adopt_runbook', key: 'bug-fix', name: 'Bug fix' })
    expect(offers[0]?.why).toContain('The goal says "ship".')
  })

  // M48 final review, Important 1: the offer's `why` is the sentence stored on the decision row and
  // shown on the Overview, so the capabilities in it are LABELS -- which is only true if the world
  // carries the taxonomy. The loader now reads it whenever runbooks matter.
  it('names a missing capability in the taxonomy\'s words when the world carries one', () => {
    const runbooks = [
      runbook({ key: 'feature-delivery', name: 'Feature delivery', keywords: ['ship'], requiredCapabilities: ['security.application'] }),
    ]
    const w = world({ goal: 'Ship the endpoint', tasks: [], runbooks, taxonomy: TAXONOMY })
    const situation = observe(w).find((s) => s.kind === 'runbook_recommended')
    expect(situation).toBeDefined()
    if (situation === undefined) return
    const offers = candidates(situation, w)
    expect(offers[0]?.why).toContain('Application security')
    expect(offers[0]?.why).not.toContain('security.application')
    expect((offers[0]?.action as { rationale: string }).rationale).toContain('Application security')
  })
})
