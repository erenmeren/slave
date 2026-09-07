import { describe, expect, it } from 'vitest'
import type { RoleDefinition } from '../../src/core/sector.js'
import { demoDefinition } from '../../src/software/definition.js'
import { softwareModel } from '../../src/software/model.js'
import { SoftwareRulesDecisionProvider } from '../../src/software/rules.js'
import { initialSoftwareState, type SoftwareState, type Task } from '../../src/software/state.js'
import { CHECKOUT_ROSTER } from './roster.js'

const ENGINEERS = [
  { id: 'Alex', expertise: 'backend' as const },
  { id: 'Emma', expertise: 'frontend' as const },
  { id: 'Daniel', expertise: 'devops' as const },
  { id: 'Maya', expertise: 'general' as const },
]

function task(over: Partial<Task> & Pick<Task, 'id' | 'area'>): Task {
  return {
    sizeDays: 2, origin: 'request', priority: 'normal', requestedDay: 0, dueDay: 10, queuedDay: 0, assignedTo: null,
    startedDay: null, finishedDay: null, doneDay: null, status: 'queued', reviewed: false, rework: 0, sourceTaskId: null, ...over,
  }
}

function stateWith(tasks: readonly Task[], over: Partial<SoftwareState> = {}): SoftwareState {
  const base = initialSoftwareState({ engineers: ENGINEERS, reviewCapacityPerDay: 1, reviewEverything: false, matchWaitDays: 0 })
  return { ...base, tasks: [...tasks], ...over }
}

function decide(policy: 'A' | 'B', roleName: string, state: SoftwareState, day: number) {
  const definition = demoDefinition({ policy, seed: 1, roster: CHECKOUT_ROSTER, currency: 'USD' })
  const role = definition.roles.find((r: RoleDefinition) => r.name === roleName)
  if (role === undefined) throw new Error(`no role ${roleName}`)
  const observation = softwareModel.observe(state, role)
  return { role, actions: new SoftwareRulesDecisionProvider(definition).decide({ day, role, observation, index: 0 }) }
}

describe('the software rules provider', () => {
  it('product accepts every requested task, oldest first', () => {
    const state = stateWith([
      task({ id: 't-2', area: 'frontend', status: 'requested', queuedDay: null, requestedDay: 2 }),
      task({ id: 't-1', area: 'backend', status: 'requested', queuedDay: null, requestedDay: 1 }),
      task({ id: 't-3', area: 'devops', status: 'queued', queuedDay: 1 }),
    ])
    const { actions } = decide('A', 'product', state, 3)
    expect(actions.map((a) => [a.type, a.params['taskId']])).toEqual([['accept_request', 't-1'], ['accept_request', 't-2']])
  })

  it('the lead takes incidents before normal work, then the older queuedDay, then id order', () => {
    const state = stateWith([
      task({ id: 't-1', area: 'backend', queuedDay: 1 }),
      task({ id: 't-2', area: 'frontend', queuedDay: 0 }),
      task({ id: 't-3', area: 'devops', queuedDay: 3, priority: 'incident' }),
    ])
    const { actions } = decide('A', 'lead', state, 4)
    expect(actions.map((a) => a.params['taskId'])).toEqual(['t-3', 't-2', 't-1'])
  })

  it('policy A takes the first free engineer whatever the expertise; policy B waits for a match', () => {
    const state = stateWith([task({ id: 't-1', area: 'devops', queuedDay: 4 })])
    expect(decide('A', 'lead', state, 4).actions.map((a) => a.params['engineerId'])).toEqual(['Alex'])
    expect(decide('B', 'lead', state, 4).actions.map((a) => a.params['engineerId'])).toEqual(['Daniel'])

    // `matchWaitDays` is observed from the state (where `softwareInitialEngineState` copies it out
    // of the definition), so a B-policy wait has to be set up on the state, not just the policy.
    const noMatch = stateWith([task({ id: 't-1', area: 'devops', queuedDay: 4 })], {
      matchWaitDays: 2,
      engineers: ENGINEERS.map((e) => (e.id === 'Daniel' ? { ...e, busyUntilDay: 9, taskId: 't-9', absentUntilDay: null } : { ...e, busyUntilDay: null, taskId: null, absentUntilDay: null })),
    })
    // Day 4, queued day 4: nothing waited yet, and matchWaitDays is 2 → B holds the task back.
    expect(decide('B', 'lead', noMatch, 4).actions).toEqual([])
    expect(decide('B', 'lead', noMatch, 5).actions).toEqual([])
    // Day 6: two days waited → B settles for whoever is free.
    expect(decide('B', 'lead', noMatch, 6).actions.map((a) => a.params['engineerId'])).toEqual(['Alex'])
    // A never waits.
    expect(decide('A', 'lead', noMatch, 4).actions.map((a) => a.params['engineerId'])).toEqual(['Alex'])
  })

  it('the lead never hands one engineer two tasks in a step and skips the busy and the absent', () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => task({ id: `t-${n}`, area: 'backend', queuedDay: 0 }))
    const state = stateWith(many, {
      engineers: [
        { id: 'Alex', expertise: 'backend', busyUntilDay: 7, taskId: 't-9', absentUntilDay: null },
        { id: 'Emma', expertise: 'frontend', busyUntilDay: null, taskId: null, absentUntilDay: 9 },
        { id: 'Daniel', expertise: 'devops', busyUntilDay: null, taskId: null, absentUntilDay: null },
        { id: 'Maya', expertise: 'general', busyUntilDay: null, taskId: null, absentUntilDay: null },
      ],
    })
    const { role, actions } = decide('A', 'lead', state, 5)
    expect(role.constraints['maxAssignmentsPerStep']).toBe(4)
    expect(actions.map((a) => [a.params['taskId'], a.params['engineerId']])).toEqual([['t-1', 'Daniel'], ['t-2', 'Maya']])
  })

  it('the reviewer reviews the oldest in-review tasks up to the remaining capacity', () => {
    const state = stateWith([
      task({ id: 't-1', area: 'backend', status: 'in_review', finishedDay: 5 }),
      task({ id: 't-2', area: 'frontend', status: 'in_review', finishedDay: 3 }),
      task({ id: 't-3', area: 'devops', status: 'in_review', finishedDay: 4 }),
    ], { reviewCapacityPerDay: 2, reviewedToday: 0 })
    expect(decide('A', 'reviewer', state, 6).actions.map((a) => a.params['taskId'])).toEqual(['t-2', 't-3'])
    const spent = { ...state, reviewedToday: 2 }
    expect(decide('A', 'reviewer', spent, 6).actions).toEqual([])
  })
})
