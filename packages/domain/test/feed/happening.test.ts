import { describe, expect, it } from 'vitest'
import { HAPPENING_TYPES, happeningSentence } from '../../src/feed/happening.js'

const names = { actor: 'Emma', taskTitle: 'Checkout form' }

describe('happeningSentence', () => {
  // `task.completed` is not a real DomainEventType (see enums.ts) -- `task.done` is the real event
  // fired when a task's board status reaches `done`, and it is what the sentence table keys on.
  it('names the actor and quotes the task for task.done', () => {
    expect(happeningSentence('task.done', {}, names)).toBe('Emma finished "Checkout form"')
  })

  it('says who started what', () => {
    expect(happeningSentence('run.started', {}, names)).toBe('Emma started "Checkout form"')
  })

  it('reads the operator request off workspace.goal_set', () => {
    expect(happeningSentence('workspace.goal_set', { request: 'Use Stripe' }, { actor: null, taskTitle: null })).toBe(
      'You asked for: Use Stripe',
    )
  })

  it('falls back to feedSummary for a type it does not name', () => {
    expect(happeningSentence('run.tool_call', { summary: 'read src/a.ts' }, names)).toBe('read src/a.ts')
  })

  // R8: the feed says what the Supervisor did. `supervisor.applied`'s real payload is
  // `{ decisionId, action }` with the whole action on it (Task 8, erratum E9), and `verbPhrase`
  // still reads each field defensively: a row written before that widening carries the kind alone,
  // and the sentence falls back to a bare one exactly as `supervisor.decided`'s own `summary`
  // fallback does above.
  it('names the six autonomous verbs supervisor.applied carries out', () => {
    expect(happeningSentence('supervisor.applied', { action: { kind: 'retry_task', title: 'Checkout form' } }, names)).toBe(
      'The Supervisor retried "Checkout form"',
    )
    expect(
      happeningSentence('supervisor.applied', { action: { kind: 'retry_review', title: 'Checkout form' } }, names),
    ).toBe('The Supervisor sent "Checkout form" back to review')
    expect(happeningSentence('supervisor.applied', { action: { kind: 'clear_halt' } }, names)).toBe(
      'The Supervisor cleared the halt',
    )
    expect(
      happeningSentence(
        'supervisor.applied',
        { action: { kind: 'request_permission', kindLabel: 'network access', name: 'Emma' } },
        names,
      ),
    ).toBe('The Supervisor granted network access to Emma')
    expect(happeningSentence('supervisor.applied', { action: { kind: 'hire_from_catalog', name: 'Alex' } }, names)).toBe(
      'The Supervisor hired Alex',
    )
    expect(happeningSentence('supervisor.applied', { action: { kind: 'unblock_task' } }, names)).toBe(
      'The Supervisor unblocked a task',
    )
    expect(happeningSentence('supervisor.applied', { action: { kind: 'steer_run' } }, names)).toBe(
      'The Supervisor steered a worker',
    )
  })

  // The payload `applyDecision` actually appends, field for field (Task 8, erratum E9) -- the
  // whole `retry_task` action the rules built, grant and reason and all, rather than the two keys
  // a phrase happens to want. The row this renders is the one a person reads on Home after the
  // Supervisor has got a failed task moving again without them.
  it('says what the Supervisor did from the whole action applyDecision appends', () => {
    expect(
      happeningSentence(
        'supervisor.applied',
        {
          decisionId: 'd-1',
          action: {
            kind: 'retry_task',
            taskId: 't-1',
            title: 'Research the market',
            reason: 'The last run was refused ‘Fetch over the network’.',
            grant: { slaveId: 's-1', permissionKind: 'network_fetch' },
          },
        },
        names,
      ),
    ).toBe('The Supervisor retried "Research the market"')
  })

  it('falls back to naming the kind for a supervisor.applied action outside the autonomous six', () => {
    expect(happeningSentence('supervisor.applied', { action: { kind: 'mark_task_failed' } }, names)).toBe(
      'The Supervisor applied mark_task_failed',
    )
  })

  // Final review, Minor 1: a verb after "could not" is an infinitive. The applied table is past
  // tense ("retried"), and reading it here printed "could not retried" on the one line Home shows
  // a person when the Supervisor's own remedy did not work.
  it('says the verb in the infinitive on supervisor.failed, and names the reason or "unknown"', () => {
    expect(
      happeningSentence(
        'supervisor.failed',
        { action: { kind: 'retry_task', title: 'Checkout form' }, reason: 'the reviewer role is empty' },
        names,
      ),
    ).toBe('The Supervisor could not retry "Checkout form": the reviewer role is empty')
    expect(happeningSentence('supervisor.failed', { action: { kind: 'clear_halt' } }, names)).toBe(
      'The Supervisor could not clear the halt: unknown',
    )
  })

  it('has an infinitive for every kind the applied table has a past tense for', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ kind: 'retry_task', title: 'Checkout form' }, 'The Supervisor could not retry "Checkout form": unknown'],
      [{ kind: 'retry_task' }, 'The Supervisor could not retry a task: unknown'],
      [
        { kind: 'retry_review', title: 'Checkout form' },
        'The Supervisor could not send "Checkout form" back to review: unknown',
      ],
      [{ kind: 'retry_review' }, 'The Supervisor could not send a task back to review: unknown'],
      [{ kind: 'clear_halt' }, 'The Supervisor could not clear the halt: unknown'],
      [
        { kind: 'request_permission', kindLabel: 'network access', name: 'Emma' },
        'The Supervisor could not grant network access to Emma: unknown',
      ],
      [{ kind: 'request_permission' }, 'The Supervisor could not grant a permission: unknown'],
      [{ kind: 'hire_from_catalog', name: 'Alex' }, 'The Supervisor could not hire Alex: unknown'],
      [{ kind: 'hire_from_catalog' }, 'The Supervisor could not hire someone: unknown'],
      [{ kind: 'unblock_task' }, 'The Supervisor could not unblock a task: unknown'],
      [{ kind: 'steer_run' }, 'The Supervisor could not steer a worker: unknown'],
      // Outside the table: "apply" is already the infinitive, so the fallback keeps its shape.
      [{ kind: 'mark_task_failed' }, 'The Supervisor could not apply mark_task_failed: unknown'],
      [{}, 'The Supervisor could not apply something: unknown'],
    ]
    for (const [action, sentence] of cases) {
      expect(happeningSentence('supervisor.failed', { action }, names)).toBe(sentence)
    }
  })

  it('never leaks a bare event type', () => {
    for (const type of HAPPENING_TYPES) {
      expect(happeningSentence(type, {}, { actor: null, taskTitle: null })).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })
})
