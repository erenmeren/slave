import { describe, expect, it } from 'vitest'
import { COOLDOWN_MS, INTEGRATED_STALE_MS, WAITING_STALE_MS } from '../../src/supervisor/constants.js'
import { filterFresh, observe, staffableSlaves } from '../../src/supervisor/observe.js'
import { SITUATION_KINDS, situationSchema } from '../../src/supervisor/situations.js'
import { NOW, TAXONOMY, decision, keys, question, runbook, slave, task, world } from './fixtures.js'

describe('observe -- no_reviewer', () => {
  it('reports it when a task is reviewing and no slave holds reviewer', () => {
    const w = world({ tasks: [task({ status: 'reviewing' })], slaves: [slave({ runtimeRoles: ['backend'] })] })
    expect(keys(observe(w))).toEqual([['no_reviewer', 'reviewer']])
  })

  it('stays silent when a slave holds reviewer', () => {
    const w = world({ tasks: [task({ status: 'reviewing' })], slaves: [slave({ runtimeRoles: ['backend', 'reviewer'] })] })
    expect(observe(w)).toEqual([])
  })

  it('stays silent when nothing is in review, reviewer-less or not', () => {
    expect(observe(world({ tasks: [task({ status: 'running' })], slaves: [] }))).toEqual([])
  })
})

describe('observe -- no_planner', () => {
  it('reports it when a goal is set, there are no tasks and no slave holds manager', () => {
    const w = world({ goal: 'Ship the checkout flow', slaves: [slave({ runtimeRoles: ['backend'] })] })
    expect(keys(observe(w))).toEqual([['no_planner', 'manager']])
  })

  it('stays silent when a slave holds manager', () => {
    const w = world({ goal: 'Ship the checkout flow', slaves: [slave({ runtimeRoles: ['manager'] })] })
    expect(observe(w)).toEqual([])
  })

  it('stays silent when there is no goal to plan', () => {
    expect(observe(world({ goal: null, slaves: [slave({ runtimeRoles: ['backend'] })] }))).toEqual([])
  })

  it('stays silent once the goal has become tasks', () => {
    const w = world({ goal: 'Ship it', tasks: [task({ status: 'running' })], slaves: [slave({ runtimeRoles: ['backend'] })] })
    expect(observe(w)).toEqual([])
  })
})

describe('observe -- review_cap_blocked vs task_blocked_human', () => {
  it('reports review_cap_blocked for a blocked task parked at the review cap', () => {
    const w = world({ tasks: [task({ status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted' })] })
    expect(keys(observe(w))).toEqual([['review_cap_blocked', 't1']])
  })

  it('reports task_blocked_human for a blocked task parked by anything else', () => {
    const w = world({ tasks: [task({ status: 'blocked', latestGuardrail: null })] })
    expect(keys(observe(w))).toEqual([['task_blocked_human', 't1']])
  })

  it('reports task_blocked_human for a blocked task whose latest guardrail is a different one', () => {
    const w = world({ tasks: [task({ status: 'blocked', latestGuardrail: 'budget_exhausted' })] })
    expect(keys(observe(w))).toEqual([['task_blocked_human', 't1']])
  })

  it('stays silent for an unblocked task carrying the cap guardrail from a past life', () => {
    const w = world({ tasks: [task({ status: 'rework', latestGuardrail: 'review_retry_cap_exhausted' })] })
    expect(observe(w)).toEqual([])
  })
})

describe('observe -- task_failed', () => {
  it('reports a failed task that other work depends on', () => {
    const w = world({ tasks: [task({ status: 'failed', dependents: 2 })] })
    const situations = observe(w)
    expect(keys(situations)).toEqual([['task_failed', 't1']])
    expect(situations[0]?.facts.dependents).toBe(2)
  })

  it('stays silent for a failed task nothing depends on', () => {
    expect(observe(world({ tasks: [task({ status: 'failed', dependents: 0 })] }))).toEqual([])
  })
})

describe('observe -- waiting_stale', () => {
  // The holder is `s2`, not the default `s1`: `s1` is the fixture's ASKER, and a role held only by
  // the asker has no holder who could answer (M39 residual R2 -- see the asker-exclusion cases in
  // the `unanswerable_question` block below).
  it('reports a question older than WAITING_STALE_MS whose recipient role has a holder', () => {
    const w = world({
      questions: [question({ createdAt: NOW - WAITING_STALE_MS - 1, recipientRole: 'backend' })],
      slaves: [slave(), slave({ id: 's2', runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['waiting_stale', 'm1']])
  })

  it('stays silent at exactly WAITING_STALE_MS -- the threshold is strictly greater-than', () => {
    const w = world({
      questions: [question({ createdAt: NOW - WAITING_STALE_MS, recipientRole: 'backend' })],
      slaves: [slave(), slave({ id: 's2', runtimeRoles: ['backend'] })],
    })
    expect(observe(w)).toEqual([])
  })

  it('reports a stale question addressed to a named slave that exists', () => {
    const w = world({
      questions: [question({ createdAt: NOW - WAITING_STALE_MS - 1, recipientRole: null, recipientSlaveId: 's2' })],
      slaves: [slave({ id: 's2', runtimeRoles: [] })],
    })
    expect(keys(observe(w))).toEqual([['waiting_stale', 'm1']])
  })
})

describe('observe -- unanswerable_question', () => {
  it('reports a question whose recipient role no slave holds, however fresh', () => {
    const w = world({
      questions: [question({ createdAt: NOW, recipientRole: 'security' })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
  })

  it('reports a question addressed to a slave that is not in the workspace', () => {
    const w = world({
      questions: [question({ recipientRole: null, recipientSlaveId: 'gone' })],
      slaves: [slave({ id: 's1' })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
  })

  /**
   * M50 final wave, I2. A released worker is still a row in the workspace -- nothing is deleted
   * (R5) -- so the id lookup found it and the question read as deliverable. It is not: the
   * engagement is over, the worker will never be dispatched again, and the asking run would sit in
   * `waiting` until `waiting_stale` nudged a human. `unanswerable_question` is the truth, and it
   * fires at once.
   */
  it('reports a question addressed by id to a worker whose engagement is over', () => {
    const w = world({
      questions: [question({ recipientRole: null, recipientSlaveId: 's2' })],
      slaves: [slave({ id: 's1' }), slave({ id: 's2', lifecycle: 'ephemeral', released: true, runtimeRoles: [] })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
  })

  it('stays silent for a fresh question whose role has a holder other than the asker', () => {
    const w = world({
      questions: [question({ recipientRole: 'backend' })],
      slaves: [slave(), slave({ id: 's2', runtimeRoles: ['backend'] })],
    })
    expect(observe(w)).toEqual([])
  })

  /**
   * M39 residual R2 (M40 t1). Control's `holdersOf` has excluded the asker since erratum E8 --
   * nobody answers their own question -- while this file's `roleHasHolder` did not. A question
   * addressed to a role whose ONLY holder is the worker that asked it therefore read as
   * deliverable: no situation, no proposal, and a panel saying "0 workers could answer it" beside
   * nothing at all. It is unanswerable, and now it says so.
   */
  it('reports a question whose recipient role is held only by the asker', () => {
    const w = world({
      questions: [question({ askerSlaveId: 's1', recipientRole: 'backend' })],
      slaves: [slave({ id: 's1', runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
  })

  it('stays silent when the asker holds the role AND somebody else does too', () => {
    const w = world({
      questions: [question({ askerSlaveId: 's1', recipientRole: 'backend' })],
      slaves: [slave({ id: 's1', runtimeRoles: ['backend'] }), slave({ id: 's2', runtimeRoles: ['backend'] })],
    })
    expect(observe(w)).toEqual([])
  })

  it('never excludes the asker from the staffing predicates -- a reviewer who asked still reviews', () => {
    // `no_reviewer` is about who can be DISPATCHED, not about who can answer a question, so the
    // asker exclusion must not leak into it: one slave holding `reviewer` is a reviewer, whatever
    // questions they have asked.
    const w = world({
      tasks: [task({ status: 'reviewing' })],
      questions: [question({ askerSlaveId: 's1', recipientRole: 'backend' })],
      slaves: [slave({ id: 's1', runtimeRoles: ['reviewer'] })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
  })

  /**
   * The facts are the evidence the row keeps for months (they survive into `SupervisorDecision.
   * situation`), so the two M39 additions are asserted as VALUES: `taskId` is what the answer
   * prompt's task text is loaded from, and `holders` is a COUNT rather than the id list -- facts
   * are flat scalars, and "how many people could answer this" is the fact a reader of the row
   * wants a year later.
   */
  it('records the asking task and how many slaves could answer, on both question situations', () => {
    const unanswerable = observe(
      world({ questions: [question({ recipientRole: 'security', taskId: 't7', holders: [] })], slaves: [slave()] }),
    )[0]
    expect(unanswerable?.kind).toBe('unanswerable_question')
    expect(unanswerable?.facts).toEqual({
      messageId: 'm1',
      askerSlaveId: 's1',
      recipientRole: 'security',
      recipientSlaveId: null,
      taskId: 't7',
      holders: 0,
      waitingMs: 0,
    })

    const stale = observe(
      world({
        questions: [question({ createdAt: NOW - WAITING_STALE_MS - 1, taskId: null, holders: ['s1', 's2'] })],
        slaves: [slave({ id: 's1' }), slave({ id: 's2' })],
      }),
    )[0]
    expect(stale?.kind).toBe('waiting_stale')
    expect(stale?.facts.taskId).toBeNull()
    expect(stale?.facts.holders).toBe(2)
    expect(stale?.facts.waitingMs).toBe(WAITING_STALE_MS + 1)
  })
})

describe('observe -- ready_unstaffed', () => {
  it('reports the missing ROLE, once, however many ready tasks want it', () => {
    const w = world({
      tasks: [
        task({ id: 't1', status: 'ready', requiredRole: 'frontend' }),
        task({ id: 't2', status: 'ready', requiredRole: 'frontend' }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['ready_unstaffed', 'frontend']])
  })

  it('stays silent when a slave holds the required role', () => {
    const w = world({ tasks: [task({ status: 'ready', requiredRole: 'frontend' })], slaves: [slave({ runtimeRoles: ['frontend'] })] })
    expect(observe(w)).toEqual([])
  })

  it('stays silent for a ready task whose required role is the empty string -- "any role" is not a missing role', () => {
    // '' is a real `requiredRole` (`SchedulableSlave.runtimeRoles` in scheduler/decide.ts reasons
    // about it). Keying a situation on it would put an empty `subjectId` on the row, which
    // `situationSchema` rejects and which every such task would collide on.
    const w = world({ tasks: [task({ status: 'ready', requiredRole: '', dependenciesDone: true })], slaves: [] })
    expect(observe(w)).toEqual([])
  })

  it('stays silent for a ready task whose dependencies are not done -- it is not startable yet', () => {
    const w = world({ tasks: [task({ status: 'ready', requiredRole: 'frontend', dependenciesDone: false })], slaves: [] })
    expect(observe(w)).toEqual([])
  })
})

describe('observe -- done_not_integrated_stale', () => {
  it('reports a done, unintegrated task with dependents that has sat past INTEGRATED_STALE_MS', () => {
    const w = world({
      tasks: [task({ status: 'done', integratedAt: null, dependents: 1, statusSince: NOW - INTEGRATED_STALE_MS - 1 })],
    })
    expect(keys(observe(w))).toEqual([['done_not_integrated_stale', 't1']])
  })

  it('stays silent once the task is integrated', () => {
    const w = world({
      tasks: [task({ status: 'done', integratedAt: NOW - 1, dependents: 1, statusSince: NOW - INTEGRATED_STALE_MS - 1 })],
    })
    expect(observe(w)).toEqual([])
  })

  it('stays silent at exactly INTEGRATED_STALE_MS, and when nothing depends on it', () => {
    const atThreshold = world({
      tasks: [task({ status: 'done', dependents: 1, statusSince: NOW - INTEGRATED_STALE_MS })],
    })
    expect(observe(atThreshold)).toEqual([])
    const noDependents = world({
      tasks: [task({ status: 'done', dependents: 0, statusSince: NOW - INTEGRATED_STALE_MS - 1 })],
    })
    expect(observe(noDependents)).toEqual([])
  })
})

describe('observe -- workspace_halted', () => {
  it('reports the halt against the workspace id', () => {
    const situations = observe(world({ halted: { reason: 'budget_exhausted' } }))
    expect(keys(situations)).toEqual([['workspace_halted', 'ws-1']])
    expect(situations[0]?.facts.reason).toBe('budget_exhausted')
  })

  it('stays silent while the workspace runs', () => {
    expect(observe(world({ halted: null }))).toEqual([])
  })
})

describe('observe -- ordering', () => {
  it('orders by SITUATION_KINDS, then by subjectId ascending', () => {
    const w = world({
      halted: { reason: 'budget_exhausted' },
      tasks: [
        task({ id: 't-b', status: 'blocked' }),
        task({ id: 't-a', status: 'blocked' }),
        task({ id: 't-r', status: 'reviewing' }),
        task({ id: 't-f', status: 'failed', dependents: 1 }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([
      ['no_reviewer', 'reviewer'],
      ['task_failed', 't-f'],
      ['task_blocked_human', 't-a'],
      ['task_blocked_human', 't-b'],
      ['workspace_halted', 'ws-1'],
    ])
    const order = observe(w).map((s) => SITUATION_KINDS.indexOf(s.kind))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('filterFresh', () => {
  const halted = world({ halted: { reason: 'budget_exhausted' } })

  it('keeps a situation no decision has ever covered', () => {
    expect(filterFresh(observe(halted), halted)).toHaveLength(1)
  })

  it('drops a situation whose key already has a pending decision', () => {
    const w = { ...halted, decisions: [decision({ situationKind: 'workspace_halted', subjectId: 'ws-1', status: 'pending', tier: 'escalated', createdAt: NOW - COOLDOWN_MS * 10, resolvedAt: null })] }
    expect(filterFresh(observe(w), w)).toEqual([])
  })

  it('drops a situation resolved exactly COOLDOWN_MS ago -- the edge is still cooling', () => {
    const w = { ...halted, decisions: [decision({ status: 'approved', tier: 'escalated', createdAt: NOW - COOLDOWN_MS * 2, resolvedAt: NOW - COOLDOWN_MS })] }
    expect(filterFresh(observe(w), w)).toEqual([])
  })

  it('keeps a situation resolved one millisecond past the cooldown', () => {
    const w = { ...halted, decisions: [decision({ status: 'approved', tier: 'escalated', createdAt: NOW - COOLDOWN_MS * 3, resolvedAt: NOW - COOLDOWN_MS - 1 })] }
    expect(filterFresh(observe(w), w)).toHaveLength(1)
  })

  it('cools an auto-applied decision from its createdAt -- it carries no resolvedAt', () => {
    const cooling = { ...halted, decisions: [decision({ status: 'applied', tier: 'applied', createdAt: NOW - COOLDOWN_MS, resolvedAt: null })] }
    expect(filterFresh(observe(cooling), cooling)).toEqual([])
    const cooled = { ...halted, decisions: [decision({ status: 'applied', tier: 'applied', createdAt: NOW - COOLDOWN_MS - 1, resolvedAt: null })] }
    expect(filterFresh(observe(cooled), cooled)).toHaveLength(1)
  })

  it('does not let a decision about one subject silence another', () => {
    const w = world({
      tasks: [task({ id: 't1', status: 'blocked' }), task({ id: 't2', status: 'blocked' })],
      decisions: [decision({ situationKind: 'task_blocked_human', subjectId: 't1', status: 'pending', tier: 'proposed' })],
    })
    expect(keys(filterFresh(observe(w), w))).toEqual([['task_blocked_human', 't2']])
  })

  it('does not let a decision of one kind silence another kind about the same subject', () => {
    const w = world({
      tasks: [task({ id: 't1', status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted' })],
      decisions: [decision({ situationKind: 'task_blocked_human', subjectId: 't1', status: 'pending', tier: 'proposed' })],
    })
    expect(keys(filterFresh(observe(w), w))).toEqual([['review_cap_blocked', 't1']])
  })
})

describe('observe -- what it produces is storable', () => {
  it('emits situations that survive situationSchema, the validator that reads them back off the row', () => {
    const w = world({
      goal: 'Ship it',
      halted: { reason: 'budget_exhausted' },
      tasks: [
        task({ id: 't1', status: 'blocked' }),
        task({ id: 't2', status: 'blocked', latestGuardrail: 'review_retry_cap_exhausted' }),
        task({ id: 't3', status: 'failed', dependents: 1 }),
        task({ id: 't4', status: 'reviewing' }),
        task({ id: 't5', status: 'ready', requiredRole: 'frontend' }),
        // '' must not become a situation at all -- if it ever did, its empty `subjectId` would
        // fail the sweep below, which is the point of leaving it in this fixture.
        task({ id: 't7', status: 'ready', requiredRole: '' }),
        task({ id: 't6', status: 'done', dependents: 1, statusSince: 0 }),
      ],
      questions: [question({ recipientRole: 'security' }), question({ messageId: 'm2', createdAt: 0 })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    const situations = observe(w)
    expect(situations.length).toBeGreaterThan(6)
    for (const situation of situations) {
      const parsed = situationSchema.safeParse(situation)
      expect(parsed.success, `${situation.kind} did not validate`).toBe(true)
    }
  })
})

describe('observe -- capability_unstaffed (M47 R4)', () => {
  it('fires per CAPABILITY when a startable task needs one nobody can be dispatched for', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['capability_unstaffed', 'security.application']])
    expect(observe(w)[0]?.facts).toEqual({ capability: 'security.application', role: 'security', readyTasks: 1, firstTaskId: 't1' })
  })

  // Final review, Minor 5a: a person reads this sentence on the Supervisor panel and again on the
  // Organization page, and it printed the dotted key at them. The key stays on `subjectId` and on
  // `facts.capability`, which is where every machine reader takes it from.
  it('says what is missing in the taxonomy\'s words, never in its keys', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    const summary = observe(w)[0]?.summary ?? ''
    expect(summary).toBe('1 startable task(s) need Application security and no slave can be dispatched as security.')
    expect(summary).not.toContain('security.application')
  })

  it('does not fire when somebody holds the role the capability projects to', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['security'] })],
    })
    expect(observe(w)).toEqual([])
  })

  // E8: supersession is per TASK, and it is what stops one gap producing two proposals.
  it('supersedes ready_unstaffed for the task that raised it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w)).map(([kind]) => kind)).not.toContain('ready_unstaffed')
  })

  it('leaves ready_unstaffed alone for a task that declared no capabilities', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't1', status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] }),
        task({ id: 't2', status: 'ready', requiredRole: 'frontend', requiredCapabilities: [] }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([
      ['capability_unstaffed', 'security.application'],
      ['ready_unstaffed', 'frontend'],
    ])
  })

  it('still raises ready_unstaffed for a task whose capabilities are all staffed but whose role is not held', () => {
    // A hand-set `requiredRole` an operator typed, with capabilities somebody does hold.
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'qa', requiredCapabilities: ['backend.api-design'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['ready_unstaffed', 'qa']])
  })

  it('counts the tasks and names the first, and ignores a task whose dependencies are not done', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't2', status: 'ready', requiredCapabilities: ['security.application'] }),
        task({ id: 't1', status: 'ready', requiredCapabilities: ['security.application'] }),
        task({ id: 't3', status: 'ready', requiredCapabilities: ['security.application'], dependenciesDone: false }),
      ],
      slaves: [],
    })
    expect(observe(w)[0]?.facts.readyTasks).toBe(2)
    expect(observe(w)[0]?.facts.firstTaskId).toBe('t2')
  })

  // R1, restated as a predicate: nothing matches on a key that is not a row, so a workspace whose
  // taxonomy has never been synced raises the role gap it always did and nothing more.
  it('is a no-op under an empty taxonomy, and the role gap is still reported', () => {
    const w = world({
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['ready_unstaffed', 'security']])
  })

  // Fix round 1, Minor 3: the E8 combination the first pass tested only one half of at a time.
  it('raises one capability situation, and no role gap, for a task with one staffed and one unstaffed key', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({
          status: 'ready',
          requiredRole: 'security',
          requiredCapabilities: ['backend.api-design', 'security.application'],
        }),
      ],
      // Holds `backend`, so `backend.api-design` is staffed and `security.application` is not.
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['capability_unstaffed', 'security.application']])
  })

  it('raises the role gap for a task whose capabilities are ALL staffed but whose typed role is unheld', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ status: 'ready', requiredRole: 'qa', requiredCapabilities: ['backend.api-design'] }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['ready_unstaffed', 'qa']])
  })

  it('produces a situation that validates against situationSchema', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
    })
    for (const situation of observe(w)) expect(situationSchema.safeParse(situation).success).toBe(true)
  })
})

describe('runbook_recommended (M48 R5)', () => {
  it('fires on a goal, no runbook and an empty board, with the workspace as its subject', () => {
    const w = world({ goal: 'Ship the endpoint', tasks: [], runbooks: [runbook({ key: 'feature-delivery', keywords: ['ship'] })] })
    const found = observe(w).find((s) => s.kind === 'runbook_recommended')
    expect(found?.subjectId).toBe(w.workspaceId)
    expect(found?.facts).toMatchObject({ runbook: 'feature-delivery' })
  })

  // M48 final review, Important 1: the rationale a person reads names capabilities in the TAXONOMY'S
  // WORDS (`docs/ia.md` rule 3), and the words are only there if the loader read the table. This is
  // the pure half of that fix -- the world it is given has one.
  it('writes the rationale in the taxonomy\'s words, never in capability keys', () => {
    const w = world({
      goal: 'Ship the endpoint',
      tasks: [],
      taxonomy: TAXONOMY,
      runbooks: [runbook({ key: 'feature-delivery', keywords: ['ship'], requiredCapabilities: ['security.application'] })],
    })
    const found = observe(w).find((s) => s.kind === 'runbook_recommended')
    expect(found?.summary).toContain('Application security')
    expect(found?.summary).not.toContain('security.application')
  })

  it('is silent when a runbook is already adopted, when the board is not empty, and when no keyword hits', () => {
    const runbooks = [runbook({ key: 'feature-delivery', keywords: ['ship'] })]
    const adopted = world({ goal: 'Ship the endpoint', tasks: [], runbooks, runbook: runbooks[0] ?? null })
    expect(observe(adopted).some((s) => s.kind === 'runbook_recommended')).toBe(false)
    expect(observe(world({ goal: 'Ship the endpoint', tasks: [task({ id: 't1' })], runbooks })).some((s) => s.kind === 'runbook_recommended')).toBe(false)
    expect(observe(world({ goal: 'Rewrite the docs', tasks: [], runbooks })).some((s) => s.kind === 'runbook_recommended')).toBe(false)
  })
})

// Plan erratum E6: the situation is DERIVED, so the escalation sentence is appended here.
describe('task_failed carries the stage escalation (M48 R6)', () => {
  it('appends the stage sentence to the summary when the failed task has one', () => {
    const w = world({ tasks: [task({ id: 't1', status: 'failed', dependents: 2, stage: 'verify', stageEscalation: 'Page the release steward.' })] })
    const found = observe(w).find((s) => s.kind === 'task_failed')
    expect(found?.summary).toBe('Task "Add the thing" failed and 2 task(s) depend on it. Page the release steward.')
    expect(found?.facts).toMatchObject({ stage: 'verify' })
  })

  it('says exactly what it always said when the task has no stage', () => {
    const w = world({ tasks: [task({ id: 't1', status: 'failed', dependents: 2 })] })
    expect(observe(w).find((s) => s.kind === 'task_failed')?.summary).toBe('Task "Add the thing" failed and 2 task(s) depend on it.')
  })
})

describe('memory_candidates_piling (M49 R2)', () => {
  it('M49 R2: five stale candidates are one situation about the project', () => {
    const got = observe(world({ staleMemoryCandidates: 5 }))
    expect(got.map((one) => one.kind)).toEqual(['memory_candidates_piling'])
    expect(got[0]?.subjectId).toBe('ws-1')
    expect(got[0]?.facts).toEqual({ candidates: 5, olderThanHours: 24 })
  })

  it('M49 R2: four is one task nobody finished, and no situation at all', () => {
    expect(observe(world({ staleMemoryCandidates: 4 }))).toEqual([])
  })
})

describe('engagement_over', () => {
  it('raises one for an ephemeral worker whose assignment is done, keyed on the SLAVE', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', title: 'Add authentication', status: 'done' })],
        slaves: [slave({ id: 's9', name: 'Robin', lifecycle: 'ephemeral', engagementTaskId: 't1', runtimeRoles: ['security'] })],
      }),
    )
    const found = situations.filter((one) => one.kind === 'engagement_over')
    expect(found).toHaveLength(1)
    expect(found[0]?.subjectId).toBe('s9')
    expect(found[0]?.summary).toContain('Robin')
    expect(found[0]?.summary).toContain('Add authentication')
    expect(found[0]?.facts).toEqual({
      slaveId: 's9',
      name: 'Robin',
      engagementTaskId: 't1',
      engagementTaskStatus: 'done',
    })
  })

  it('raises none while the assignment is still on the board', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', status: 'running' })],
        slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1' })],
      }),
    )
    expect(situations.filter((one) => one.kind === 'engagement_over')).toEqual([])
  })

  it('raises none for a project worker, and none for one already released', () => {
    const done = [task({ id: 't1', status: 'done' })]
    expect(
      observe(world({ tasks: done, slaves: [slave({ id: 's9', engagementTaskId: 't1' })] })).filter(
        (one) => one.kind === 'engagement_over',
      ),
    ).toEqual([])
    expect(
      observe(
        world({
          tasks: done,
          slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1', released: true, runtimeRoles: [] })],
        }),
      ).filter((one) => one.kind === 'engagement_over'),
    ).toEqual([])
  })

  it('raises none while the worker still has other work assigned to it', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'ready', assigneeId: 's9' })],
        slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1' })],
      }),
    )
    expect(situations.filter((one) => one.kind === 'engagement_over')).toEqual([])
  })
})

describe('staffableSlaves', () => {
  it('never offers a role to a released worker', () => {
    const released = slave({ id: 's9', lifecycle: 'ephemeral', released: true, runtimeRoles: [] })
    expect(staffableSlaves(world({ slaves: [released] }), 'reviewer')).toEqual([])
  })
})
