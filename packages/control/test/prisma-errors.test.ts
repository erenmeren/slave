import { describe, expect, it } from 'vitest'
import { isUniqueConstraintViolation, uniqueConstraintTarget } from '../src/prisma-errors.js'

/**
 * Catalog Person Pool (Task 2): `syncPersonPool` is the first caller with TWO unique constraints
 * one `create` can hit (`Person`'s slot pair and its global name), and `uniqueConstraintTarget` is
 * how it tells a slot race from a name race apart -- caught and retried differently -- from any
 * OTHER P2002 or non-P2002 error, which must always be rethrown untouched.
 *
 * Prisma's `meta.target` shape is not part of its stable contract (this file's own docstring in
 * `prisma-errors.ts`): some engine versions report an array of column names, others a single
 * constraint-name string. Both are exercised here.
 */
describe('uniqueConstraintTarget (Catalog Person Pool Task 2)', () => {
  it('reads a column-name array target', () => {
    const error = { code: 'P2002', meta: { target: ['templateId', 'poolSlot'] } }
    expect(uniqueConstraintTarget(error)).toEqual(['templateId', 'poolSlot'])
  })

  it('reads a single constraint-name string target as a one-element array', () => {
    const error = { code: 'P2002', meta: { target: 'Person_name_key' } }
    expect(uniqueConstraintTarget(error)).toEqual(['Person_name_key'])
  })

  it('returns an empty array when there is no meta at all', () => {
    expect(uniqueConstraintTarget({ code: 'P2002' })).toEqual([])
  })

  it('returns an empty array when meta carries no target', () => {
    expect(uniqueConstraintTarget({ code: 'P2002', meta: {} })).toEqual([])
  })

  it('returns an empty array for a non-object error', () => {
    expect(uniqueConstraintTarget('not an error')).toEqual([])
    expect(uniqueConstraintTarget(null)).toEqual([])
    expect(uniqueConstraintTarget(undefined)).toEqual([])
  })

  it('drops non-string entries out of an array target rather than throwing', () => {
    const error = { code: 'P2002', meta: { target: ['ok', 42, null] } }
    expect(uniqueConstraintTarget(error)).toEqual(['ok'])
  })

  it('lets the caller distinguish the two Person constraints by substring, regardless of shape', () => {
    const slotRace = { code: 'P2002', meta: { target: ['templateId', 'poolSlot'] } }
    const slotRaceByName = { code: 'P2002', meta: { target: 'Person_templateId_poolSlot_key' } }
    const nameRace = { code: 'P2002', meta: { target: ['name'] } }
    const nameRaceByName = { code: 'P2002', meta: { target: 'Person_name_key' } }

    for (const error of [slotRace, slotRaceByName]) {
      expect(uniqueConstraintTarget(error).some((column) => column.toLowerCase().includes('poolslot'))).toBe(true)
    }
    for (const error of [nameRace, nameRaceByName]) {
      expect(uniqueConstraintTarget(error).some((column) => column.toLowerCase().includes('name'))).toBe(true)
    }
  })
})

/**
 * Catalog Person Pool (Task 2), self-review: this project's client is wired through
 * `@prisma/adapter-pg` (`packages/db/src/client.ts`), and a driver-adapter P2002 carries no
 * top-level `meta.target` at all -- confirmed against a REAL P2002 from this exact client rather
 * than assumed from documentation. These four pin that shape, byte for byte, against the two
 * constraints `syncPersonPool` actually hits.
 */
describe('uniqueConstraintTarget reading the @prisma/adapter-pg shape (Catalog Person Pool Task 2)', () => {
  it('strips the double-quote wrapping Postgres adds to a multi-column constraint', () => {
    const error = {
      code: 'P2002',
      meta: {
        modelName: 'Person',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: 'duplicate key value violates unique constraint "Person_templateId_poolSlot_key"',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['"templateId"', '"poolSlot"'] },
          },
        },
      },
    }

    expect(uniqueConstraintTarget(error)).toEqual(['templateId', 'poolSlot'])
  })

  it('leaves a single-column constraint field alone: Postgres never quotes it', () => {
    const error = {
      code: 'P2002',
      meta: {
        modelName: 'Person',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: 'duplicate key value violates unique constraint "Person_name_key"',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['name'] },
          },
        },
      },
    }

    expect(uniqueConstraintTarget(error)).toEqual(['name'])
  })

  it('still lets the caller distinguish the slot race from the name race by substring', () => {
    const slotRace = {
      code: 'P2002',
      meta: { driverAdapterError: { cause: { constraint: { fields: ['"templateId"', '"poolSlot"'] } } } },
    }
    const nameRace = { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['name'] } } } } }

    expect(uniqueConstraintTarget(slotRace).some((column) => column.toLowerCase().includes('poolslot'))).toBe(true)
    expect(uniqueConstraintTarget(nameRace).some((column) => column.toLowerCase().includes('name'))).toBe(true)
  })

  it('returns an empty array when driverAdapterError is present but carries no constraint fields', () => {
    expect(uniqueConstraintTarget({ code: 'P2002', meta: { driverAdapterError: { cause: {} } } })).toEqual([])
    expect(uniqueConstraintTarget({ code: 'P2002', meta: { driverAdapterError: {} } })).toEqual([])
  })

  it('prefers the classic meta.target over the driver-adapter shape when both are somehow present', () => {
    const error = {
      code: 'P2002',
      meta: {
        target: ['name'],
        driverAdapterError: { cause: { constraint: { fields: ['"templateId"', '"poolSlot"'] } } },
      },
    }

    expect(uniqueConstraintTarget(error)).toEqual(['name'])
  })
})

describe('isUniqueConstraintViolation alongside uniqueConstraintTarget', () => {
  it('a non-P2002 error is never mistaken for a constraint this pass could classify', () => {
    const error = { code: 'P2003', meta: { target: ['poolSlot'] } }
    expect(isUniqueConstraintViolation(error)).toBe(false)
  })
})
