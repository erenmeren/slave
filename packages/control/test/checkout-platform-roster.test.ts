import { CHECKOUT_PLATFORM_ROSTER } from '@slave-of-ai/db'
import { sectors } from '@slave-of-ai/simulation'
import { describe, expect, it } from 'vitest'

/**
 * The seed's own roster literal, checked against the sector plugins that have to accept it. No
 * database: this is a claim about the literal `packages/db/src/checkout-platform.ts` publishes and
 * `seed()` writes rows from, so it holds without anything being seeded.
 *
 * It lives in `packages/control` because control is the one package that depends on both
 * `@slave-of-ai/db` and `@slave-of-ai/simulation` -- and it is control's `rosterOf` that carries a
 * catalog company's roster from one to the other.
 */
describe('the seeded Checkout Platform roster', () => {
  it('fits the software sector, which before M31b\'s fix wave had no seeded company at all', () => {
    expect(sectors.software.rosterFits(CHECKOUT_PLATFORM_ROSTER)).toBe(true)
  })

  it('fits trade too (erratum R11: trade\'s rule is a head count)', () => {
    expect(sectors.trade.rosterFits(CHECKOUT_PLATFORM_ROSTER)).toBe(true)
  })

  it('builds a software definition whose engineer pool is the four non-reviewer Engineering slaves, ordered by id', () => {
    const definition = sectors.software.demoDefinition({ policy: 'A', seed: 1, roster: CHECKOUT_PLATFORM_ROSTER, currency: 'USD' })
    expect(definition.engineers.map((engineer: { id: string }) => engineer.id)).toEqual(['Alex', 'Daniel', 'Emma', 'Maya'])
    expect(definition.roles.map((role: { name: string; slaveName: string }) => `${role.name}:${role.slaveName}`)).toEqual(['product:John', 'lead:Atlas', 'reviewer:Riley'])
  })
})
