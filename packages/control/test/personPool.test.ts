import { describe, expect, it } from 'vitest'
import { classifyPersonCreateError, managedSlotNeedsRefresh } from '../src/personPool.js'

/**
 * Catalog Person Pool (Task 2), review fix round 1: `syncSlot`'s `catch` branch that must
 * rethrow an unrelated Prisma error untouched had no test proving it, because the standard way to
 * force an arbitrary error there -- `vi.spyOn` on a Prisma model method -- is unreliable against
 * this project's generated client (`prisma-errors.test.ts`'s own docstring; confirmed empirically
 * in the Task 2 report: `mockRestore()` left `prisma.person.create` permanently `undefined`).
 *
 * `classifyPersonCreateError` is the fix: the whole decision `syncSlot`'s `catch` makes --
 * "re-read the slot", "try another name", or "not mine, rethrow" -- extracted as one pure,
 * synchronous function with no database and nothing to spy on. Every input here is a plain
 * object literal, not a real driver error; the SHAPES those literals mimic (`meta.target`,
 * `meta.driverAdapterError...`) are `uniqueConstraintTarget`'s own concern and are exhaustively
 * covered by `prisma-errors.test.ts` already -- these tests exist to pin the DECISION this
 * function makes given `isUniqueConstraintViolation`/`uniqueConstraintTarget`'s answers, not to
 * re-verify how those two parse a `meta`.
 */
describe('classifyPersonCreateError (Catalog Person Pool Task 2, review fix round 1)', () => {
  it('rethrows a non-P2002 error untouched, regardless of what meta it carries', () => {
    const notFound = { code: 'P2025', meta: { cause: 'Record to update not found.' } }
    expect(classifyPersonCreateError(notFound)).toBe('rethrow')

    const foreignKey = { code: 'P2003', meta: { field_name: 'templateId' } }
    expect(classifyPersonCreateError(foreignKey)).toBe('rethrow')

    expect(classifyPersonCreateError(new Error('connection reset'))).toBe('rethrow')
    expect(classifyPersonCreateError('not an error at all')).toBe('rethrow')
    expect(classifyPersonCreateError(null)).toBe('rethrow')
    expect(classifyPersonCreateError(undefined)).toBe('rethrow')
  })

  it('rethrows a P2002 whose target names neither Person constraint this function knows', () => {
    // A hypothetical future unique constraint on Person -- today's schema has exactly two
    // (`name`, `(templateId, poolSlot)`), so this is deliberately neither.
    const unknownConstraint = { code: 'P2002', meta: { target: ['email'] } }
    expect(classifyPersonCreateError(unknownConstraint)).toBe('rethrow')

    const noMetaAtAll = { code: 'P2002' }
    expect(classifyPersonCreateError(noMetaAtAll)).toBe('rethrow')

    const emptyTarget = { code: 'P2002', meta: { target: [] } }
    expect(classifyPersonCreateError(emptyTarget)).toBe('rethrow')
  })

  it('classifies a `(templateId, poolSlot)` P2002 as a slot race, in either shape', () => {
    const classicShape = { code: 'P2002', meta: { target: ['templateId', 'poolSlot'] } }
    expect(classifyPersonCreateError(classicShape)).toBe('slot_race')

    const constraintNameShape = { code: 'P2002', meta: { target: 'Person_templateId_poolSlot_key' } }
    expect(classifyPersonCreateError(constraintNameShape)).toBe('slot_race')

    // The real `@prisma/adapter-pg` shape this project's client actually throws (confirmed
    // against a live P2002 for the Task 2 report), quoting each column.
    const driverAdapterShape = {
      code: 'P2002',
      meta: { driverAdapterError: { cause: { constraint: { fields: ['"templateId"', '"poolSlot"'] } } } },
    }
    expect(classifyPersonCreateError(driverAdapterShape)).toBe('slot_race')
  })

  it('classifies a `name` P2002 as a name race, in either shape', () => {
    const classicShape = { code: 'P2002', meta: { target: ['name'] } }
    expect(classifyPersonCreateError(classicShape)).toBe('name_race')

    const constraintNameShape = { code: 'P2002', meta: { target: 'Person_name_key' } }
    expect(classifyPersonCreateError(constraintNameShape)).toBe('name_race')

    const driverAdapterShape = { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['name'] } } } } }
    expect(classifyPersonCreateError(driverAdapterShape)).toBe('name_race')
  })
})

/**
 * Final review fix round 2, Important B: the pass's per-slot decision, as a pure function.
 *
 * `syncPersonPool` prefetched every managed row in one query and then called the LOCKED
 * `refreshManagedCapabilities` for every occupied slot regardless -- one `BEGIN` + `Person` `FOR
 * UPDATE` + `findUnique` + `COMMIT` per person, 834 of them on the measured installation, on a pass
 * whose honest answer for all 834 was "nothing changed". The prefetch had made the READS cheap and
 * left the transactions exactly where they were, so it optimised the wrong half.
 *
 * The prefetch now carries `capabilities` and `capabilityGrants` too, and THIS decides in memory
 * whether a row is worth a transaction at all. It is exported and tested here rather than asserted
 * about through the database for `classifyPersonCreateError`'s own reason -- the decision is pure,
 * so it deserves a test that needs no database and nothing to spy on, and `pool-sync-cost.test.ts`
 * separately proves against a real Postgres that a row this says is in step is never locked.
 */
describe('managedSlotNeedsRefresh (final review fix round 2, Important B)', () => {
  it('says no when the stored set already IS the union, whatever order either side is in', () => {
    expect(managedSlotNeedsRefresh({ capabilities: ['a', 'b'], capabilityGrants: [] }, ['a', 'b'])).toBe(false)
    // Order never mattered to anything that reads `Person.capabilities`, and a positional comparison
    // would report a write every time an import re-orders `capabilityKeys` without changing it.
    expect(managedSlotNeedsRefresh({ capabilities: ['b', 'a'], capabilityGrants: [] }, ['a', 'b'])).toBe(false)
    // A grant already applied is in step too -- the union, not the baseline, is what the column holds.
    expect(managedSlotNeedsRefresh({ capabilities: ['a', 'x.extra'], capabilityGrants: ['x.extra'] }, ['a'])).toBe(false)
    // A grant that DUPLICATES a baseline key is not a second entry: the union deduplicates.
    expect(managedSlotNeedsRefresh({ capabilities: ['a'], capabilityGrants: ['a'] }, ['a'])).toBe(false)
    expect(managedSlotNeedsRefresh({ capabilities: [], capabilityGrants: [] }, [])).toBe(false)
  })

  it('says yes for every way the union can have moved: an addition, a removal, a swap, a lost grant', () => {
    expect(managedSlotNeedsRefresh({ capabilities: ['a'], capabilityGrants: [] }, ['a', 'b'])).toBe(true)
    expect(managedSlotNeedsRefresh({ capabilities: ['a', 'b'], capabilityGrants: [] }, ['a'])).toBe(true)
    expect(managedSlotNeedsRefresh({ capabilities: ['a'], capabilityGrants: [] }, ['b'])).toBe(true)
    // The grant is on the row but was never unioned into the stored set -- exactly the state a
    // writer interrupted between its two columns would leave, and a pass that skipped it would
    // leave a person providing less than they were granted.
    expect(managedSlotNeedsRefresh({ capabilities: ['a'], capabilityGrants: ['x.extra'] }, ['a'])).toBe(true)
  })

  it('finds nothing to do across 834 slots in step -- the measured installation, one pass, zero transactions', () => {
    // 278 active templates x 3 managed slots, the shape the requirements' own recheck names. Every
    // row is in step, so a pass over this list opens no transaction at all; before this decision
    // existed it opened 834.
    const rows = Array.from({ length: 278 }, (_unused, template) => ({
      capabilityKeys: [`domain.key-${String(template)}`, 'shared.baseline'],
      slots: [1, 2, 3],
    }))
    let needed = 0
    let considered = 0
    for (const row of rows) {
      for (const _slot of row.slots) {
        considered += 1
        if (managedSlotNeedsRefresh({ capabilities: [...row.capabilityKeys].reverse(), capabilityGrants: [] }, row.capabilityKeys)) {
          needed += 1
        }
      }
    }
    expect(considered).toBe(834)
    expect(needed).toBe(0)
  })
})
