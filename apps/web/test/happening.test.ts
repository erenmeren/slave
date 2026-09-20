import { describe, expect, it } from 'vitest'
import { HAPPENING_TYPES, happeningSentence } from '../src/lib/happening.js'

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
  // `{ decisionId, action: { kind } }` -- `carryOut`'s caller never widens it past the kind -- so
  // `verbPhrase` reads whatever fields a caller happened to give it and falls back to a bare
  // sentence when the ones a phrase wants are not there, exactly as `supervisor.decided`'s own
  // `summary` fallback already does above.
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

  it('falls back to naming the kind for a supervisor.applied action outside the autonomous six', () => {
    expect(happeningSentence('supervisor.applied', { action: { kind: 'mark_task_failed' } }, names)).toBe(
      'The Supervisor applied mark_task_failed',
    )
  })

  it('names the reason on supervisor.failed, or "unknown" when the payload carries none', () => {
    expect(
      happeningSentence(
        'supervisor.failed',
        { action: { kind: 'retry_task', title: 'Checkout form' }, reason: 'the reviewer role is empty' },
        names,
      ),
    ).toBe('The Supervisor could not retried "Checkout form": the reviewer role is empty')
    expect(happeningSentence('supervisor.failed', { action: { kind: 'clear_halt' } }, names)).toBe(
      'The Supervisor could not cleared the halt: unknown',
    )
  })

  it('never leaks a bare event type', () => {
    for (const type of HAPPENING_TYPES) {
      expect(happeningSentence(type, {}, { actor: null, taskTitle: null })).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })
})
