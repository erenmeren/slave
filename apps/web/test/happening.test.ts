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

  it('never leaks a bare event type', () => {
    for (const type of HAPPENING_TYPES) {
      expect(happeningSentence(type, {}, { actor: null, taskTitle: null })).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })
})
