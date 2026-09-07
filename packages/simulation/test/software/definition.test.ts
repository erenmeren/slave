import { describe, expect, it } from 'vitest'
import { assignRoles, cloneDefinition, demoDefinition, DEMO_SCENARIO, POLICY_SETTINGS, softwareInitialEngineState, SOFTWARE_ROSTER_REQUIREMENT } from '../../src/software/definition.js'
import { CHECKOUT_ROSTER } from './roster.js'

describe('assignRoles on the Checkout Platform roster', () => {
  it('reads product from Product, lead from Management, the reviewer from the catalog role, engineers from the rest of Engineering', () => {
    const { roles, engineers } = assignRoles(CHECKOUT_ROSTER)
    expect(roles.map((r) => [r.name, r.slaveName])).toEqual([['product', 'John'], ['lead', 'Atlas'], ['reviewer', 'Riley']])
    // Ordered by id (erratum R17), not by roster position: the caller's ordering must not reach
    // the run, since policy A breaks a free-engineer tie by array position.
    expect(engineers).toEqual([
      { id: 'Alex', expertise: 'backend' },
      { id: 'Daniel', expertise: 'devops' },
      { id: 'Emma', expertise: 'frontend' },
      { id: 'Maya', expertise: 'general' },
    ])
  })

  it('prefers the `reviewer` catalog role over `QA` when the roster carries both', () => {
    const { roles, engineers } = assignRoles(CHECKOUT_ROSTER)
    expect(roles.find((r) => r.name === 'reviewer')?.slaveName).toBe('Riley')
    expect(engineers.map((e) => e.id)).toContain('Maya')
  })

  it('falls back to the QA slave when no `reviewer` role exists', () => {
    const noRiley = CHECKOUT_ROSTER.filter((r) => r.slaveName !== 'Riley')
    // Maya (QA) becomes the reviewer, so only three engineers are left.
    const { roles, engineers } = assignRoles([...noRiley, { slaveName: 'Nina', departmentName: 'Engineering', role: 'Backend' }])
    expect(roles.find((r) => r.name === 'reviewer')?.slaveName).toBe('Maya')
    expect(engineers.map((e) => e.id)).toEqual(['Alex', 'Daniel', 'Emma', 'Nina'])
  })

  it('throws the roster requirement verbatim when a role slave or a second engineer is missing', () => {
    const requirement = 'the software sector needs a Product slave, a Management slave, a QA or reviewer slave and at least two more Engineering slaves'
    expect(SOFTWARE_ROSTER_REQUIREMENT).toBe(requirement)
    expect(() => assignRoles(CHECKOUT_ROSTER.filter((r) => r.departmentName !== 'Product'))).toThrow(requirement)
    expect(() => assignRoles(CHECKOUT_ROSTER.filter((r) => r.departmentName !== 'Management'))).toThrow(requirement)
    expect(() => assignRoles(CHECKOUT_ROSTER.filter((r) => r.role !== 'reviewer' && r.role !== 'QA'))).toThrow(requirement)
    // Riley is the reviewer, Maya and Alex the only other Engineering slaves → drop one and it fails.
    const thin = CHECKOUT_ROSTER.filter((r) => !['Emma', 'Daniel', 'Maya'].includes(r.slaveName))
    expect(() => assignRoles(thin)).toThrow(requirement)
  })
})

describe('demoDefinition and cloneDefinition', () => {
  it('freezes the policy knobs: A is fast (capacity 1, no review, no wait), B is careful (2, review everything, wait 2)', () => {
    const a = demoDefinition({ policy: 'A', seed: 1, roster: CHECKOUT_ROSTER, currency: 'USD' })
    const b = demoDefinition({ policy: 'B', seed: 1, roster: CHECKOUT_ROSTER, currency: 'USD' })
    expect({ reviewCapacityPerDay: a.reviewCapacityPerDay, reviewEverything: a.reviewEverything, matchWaitDays: a.matchWaitDays }).toEqual(POLICY_SETTINGS.A)
    expect(POLICY_SETTINGS.A).toEqual({ reviewCapacityPerDay: 1, reviewEverything: false, matchWaitDays: 0 })
    expect(POLICY_SETTINGS.B).toEqual({ reviewCapacityPerDay: 2, reviewEverything: true, matchWaitDays: 2 })
    expect({ reviewCapacityPerDay: b.reviewCapacityPerDay, reviewEverything: b.reviewEverything, matchWaitDays: b.matchWaitDays }).toEqual(POLICY_SETTINGS.B)
    expect(a.roleOrder).toEqual(['product', 'lead', 'reviewer'])
    expect(a.horizonDays).toBe(30)
    expect(a.llmRoles).toEqual([])
    expect(a.scenario.requests).toEqual(DEMO_SCENARIO.requests)
  })

  it('schedules every scenario request as an external event on its own day', () => {
    const definition = demoDefinition({ policy: 'A', seed: 1, roster: CHECKOUT_ROSTER, currency: 'USD' })
    const initial = softwareInitialEngineState(definition)
    expect(initial.queue.items).toHaveLength(DEMO_SCENARIO.requests.length)
    expect(initial.queue.items.every((i) => i.priority === 'external')).toBe(true)
    expect(initial.queue.items[0]).toMatchObject({ time: 1, event: { type: 'request', area: 'backend', sizeDays: 3, dueInDays: 10 } })
    expect(initial.sector.engineers.map((e) => e.id)).toEqual(['Alex', 'Daniel', 'Emma', 'Maya'])
    expect(initial.sector.reviewCapacityPerDay).toBe(1)
  })

  it('copies everything but policy and seed, and never aliases the source', () => {
    const source = demoDefinition({ policy: 'A', seed: 3, roster: CHECKOUT_ROSTER, currency: 'USD' })
    const clone = cloneDefinition(source, { policy: 'B', seed: 9 })
    expect(clone.policy).toBe('B')
    expect(clone.seed).toBe(9)
    // The policy knobs travel with the policy: a clone into B is a careful run, not a fast one.
    expect({ reviewCapacityPerDay: clone.reviewCapacityPerDay, reviewEverything: clone.reviewEverything, matchWaitDays: clone.matchWaitDays }).toEqual(POLICY_SETTINGS.B)
    expect(clone.roles).toEqual(source.roles)
    expect(clone.roles).not.toBe(source.roles)
    expect(clone.engineers).toEqual(source.engineers)
    expect(clone.engineers).not.toBe(source.engineers)
  })
})
