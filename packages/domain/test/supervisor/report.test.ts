import { describe, expect, it } from 'vitest'
import { observe } from '../../src/supervisor/observe.js'
import { summarise } from '../../src/supervisor/report.js'
import type { SupervisorDecisionRecord } from '../../src/supervisor/world.js'
import { NOW, decision, question, slave, task, world } from './fixtures.js'

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
    expect(summarise(w).next).toEqual({ ready: 2, running: 1, waiting: 1, blocked: 1, stale: 0 })
  })

  // M40 §4: the "stale" count behind the web's badge -- planned work the goal has moved past.
  it('counts non-terminal tasks whose goalVersion is behind the workspace goal version', () => {
    const w = world({
      goalVersion: 2,
      tasks: [
        task({ id: 't1', status: 'backlog', goalVersion: 1 }),
        task({ id: 't2', status: 'running', goalVersion: 1 }),
        task({ id: 't3', status: 'ready', goalVersion: 2 }),
      ],
    })
    expect(summarise(w).next.stale).toBe(2)
  })

  it('never counts a hand-made task -- a null goalVersion was derived from no goal at all', () => {
    const w = world({ goalVersion: 3, tasks: [task({ id: 't1', status: 'backlog', goalVersion: null })] })
    expect(summarise(w).next.stale).toBe(0)
  })

  it.each(['done', 'failed', 'cancelled'] as const)('never counts a %s task -- staleness is about work still ahead', (status) => {
    const w = world({ goalVersion: 2, tasks: [task({ id: 't1', status, goalVersion: 1 })] })
    expect(summarise(w).next.stale).toBe(0)
  })

  it('counts nothing while the board is at the current goal version', () => {
    const w = world({
      goalVersion: 2,
      tasks: [task({ id: 't1', status: 'backlog', goalVersion: 2 }), task({ id: 't2', status: 'ready', goalVersion: 2 })],
    })
    expect(summarise(w).next.stale).toBe(0)
  })

  it('never counts a task AHEAD of the workspace version -- only behind is stale', () => {
    const w = world({ goalVersion: 1, tasks: [task({ id: 't1', status: 'backlog', goalVersion: 2 })] })
    expect(summarise(w).next.stale).toBe(0)
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

describe('summarise -- mailbox', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  /** A question decision, the only kind the mailbox counts. `actionKind` is what tells an ANSWER
   *  the Supervisor drafted from a re-address or an escalation on the same situation. */
  const answerDecision = (overrides: Partial<SupervisorDecisionRecord>): SupervisorDecisionRecord =>
    decision({ situationKind: 'waiting_stale', actionKind: 'answer_question', ...overrides })

  it('counts the questions still waiting, the drafts a human owes an answer to, and what was closed today', () => {
    const w = world({
      slaves: [slave({ runtimeRoles: ['backend'] })],
      questions: [question({ messageId: 'm1' }), question({ messageId: 'm2' })],
      decisions: [
        // A drafted answer waiting on a human -- an interpretation.
        answerDecision({ subjectId: 'm3', status: 'pending', tier: 'proposed' }),
        // An escalated draft is waiting on a human too: erratum E2's lexicon draft is exactly this
        // row, and a human answers the question by editing it (Task 2 fix round 1).
        answerDecision({ situationKind: 'unanswerable_question', subjectId: 'm4', status: 'pending', tier: 'escalated' }),
        // A pending re-address on a question situation is NOT a draft: nobody is approving a text.
        decision({ situationKind: 'waiting_stale', actionKind: 'reassign_question', subjectId: 'm8', status: 'pending', tier: 'proposed' }),
        // A proposal about something that is not a question at all.
        decision({ situationKind: 'ready_unstaffed', actionKind: 'set_runtime_roles', subjectId: 'backend', status: 'pending', tier: 'proposed' }),
        // Answered by the Supervisor itself, and by a human approving its draft, both in the window.
        answerDecision({ subjectId: 'm5', status: 'applied', tier: 'applied', createdAt: NOW - 1000 }),
        answerDecision({
          situationKind: 'unanswerable_question',
          subjectId: 'm6',
          status: 'approved',
          tier: 'proposed',
          createdAt: NOW - 2000,
        }),
        // The same thing, a day and a half ago: outside the window.
        answerDecision({ subjectId: 'm7', status: 'applied', tier: 'applied', createdAt: NOW - DAY_MS - 1 }),
        // A re-address that WAS applied moved the question along, but nobody answered it.
        decision({ situationKind: 'waiting_stale', actionKind: 'reassign_question', subjectId: 'm9', status: 'applied', tier: 'applied' }),
        // Closed, but not about a question.
        decision({ situationKind: 'review_cap_blocked', actionKind: 'unblock_task', subjectId: 't1', status: 'applied', tier: 'applied' }),
      ],
    })

    expect(summarise(w).mailbox).toEqual({ pendingQuestions: 2, draftsAwaiting: 2, answeredBySupervisor24h: 2 })
  })

  it('reports an empty mailbox as zeroes rather than leaving the block out', () => {
    expect(summarise(world()).mailbox).toEqual({
      pendingQuestions: 0,
      draftsAwaiting: 0,
      answeredBySupervisor24h: 0,
    })
  })

  it('counts a decision exactly 24 hours old as still inside the window', () => {
    const w = world({
      decisions: [answerDecision({ subjectId: 'm1', status: 'applied', tier: 'applied', createdAt: NOW - DAY_MS })],
    })
    expect(summarise(w).mailbox.answeredBySupervisor24h).toBe(1)
  })

  it('does not count an answer decision on a situation that is not a question', () => {
    // Belt and braces: the action names an answer, but the situation is a blocked task. Both
    // halves have to agree before the mailbox claims a question was answered.
    const w = world({
      decisions: [
        decision({ situationKind: 'review_cap_blocked', actionKind: 'answer_question', subjectId: 't1', status: 'applied', tier: 'applied' }),
      ],
    })
    expect(summarise(w).mailbox).toEqual({ pendingQuestions: 0, draftsAwaiting: 0, answeredBySupervisor24h: 0 })
  })
})
