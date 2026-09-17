import { describe, expect, it } from 'vitest'
import { classifyPersonCreateError } from '../src/personPool.js'

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
