import { describe, expect, it } from 'vitest'
import { FIRST_NAMES, LAST_NAMES, isGeneratedEnglishName, randomEnglishName, unbiasedIndex } from '../../src/persons/pool.js'

describe('unbiasedIndex', () => {
  it('retries when the first Uint32 falls in the biased tail', () => {
    // bound = 3: 2^32 = 4294967296; 4294967296 % 3 = 1; limit = 4294967295.
    // The single biased value is 4294967295 (0xFFFFFFFF). Sequence: biased first,
    // then unbiased 0 — so getUint32 must be called exactly twice.
    const bound = 3
    const calls: number[] = []
    const values = [4294967295, 0]
    const getUint32 = (): number => {
      const v = values.shift()!
      calls.push(v)
      return v
    }
    const result = unbiasedIndex(getUint32, bound)
    expect(calls).toHaveLength(2)
    expect(result).toBe(0) // 0 % 3 = 0
  })

  it('accepts the first value when it is below the limit', () => {
    const calls: number[] = []
    const getUint32 = (): number => { calls.push(6); return 6 }
    const result = unbiasedIndex(getUint32, 5)
    expect(calls).toHaveLength(1) // no retry needed
    expect(result).toBe(1) // 6 % 5 = 1
  })

  /**
   * Low-cost final-review minor. This function is EXPORTED as a seam, so its bound is an argument
   * a caller supplies rather than an internal invariant. `upperExclusive = 0` made
   * `4294967296 % 0` be `NaN`, `limit` `NaN`, `v < NaN` always false -- an infinite loop burning a
   * CPU with no error and no way to tell from a hang. A negative or fractional bound is a quieter
   * version of the same thing: a plausible-looking index outside the array it is about to index.
   * A bound is a positive integer no larger than the draw space, and anything else is a caller
   * bug that should say so at the call.
   */
  it('refuses a bound that is not a positive integer inside the 32-bit draw space', () => {
    const getUint32 = (): number => 0
    for (const bad of [0, -1, -4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4294967297]) {
      expect(() => unbiasedIndex(getUint32, bad)).toThrow(/positive integer/u)
    }
  })

  it('accepts the extremes of the range it does allow', () => {
    expect(unbiasedIndex(() => 0, 1)).toBe(0)
    expect(unbiasedIndex(() => 7, 4294967296)).toBe(7)
  })

  it('result is always in [0, upperExclusive)', () => {
    for (let bound = 1; bound <= 10; bound++) {
      // Feed a sequence that exercises multiple accepts at different remainders
      let counter = 0
      const getUint32 = (): number => counter++
      for (let i = 0; i < 20; i++) {
        const r = unbiasedIndex(getUint32, bound)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThan(bound)
      }
    }
  })
})

describe('randomEnglishName', () => {
  it('returns a string of two words separated by one space', () => {
    const name = randomEnglishName()
    const parts = name.split(' ')
    expect(parts).toHaveLength(2)
    expect(parts[0]).not.toBe('')
    expect(parts[1]).not.toBe('')
  })

  it('is deterministic when a seeded randomIndex is injected', () => {
    const fixed = (n: number) => 0
    const a = randomEnglishName(fixed)
    const b = randomEnglishName(fixed)
    expect(a).toBe(b)
  })

  it('picks first name from FIRST_NAMES dictionary', () => {
    // For each index, first name should come from the dictionary
    for (let i = 0; i < FIRST_NAMES.length; i++) {
      const name = randomEnglishName((_n) => i % FIRST_NAMES.length)
      const first = name.split(' ')[0]
      expect(FIRST_NAMES).toContain(first)
    }
  })

  it('picks last name from LAST_NAMES dictionary', () => {
    for (let i = 0; i < LAST_NAMES.length; i++) {
      const name = randomEnglishName((_n) => i % LAST_NAMES.length)
      const last = name.split(' ')[1]
      expect(LAST_NAMES).toContain(last)
    }
  })

  it('produces different names with different random indices', () => {
    const first = randomEnglishName((_n) => 0)
    // If dictionaries have more than one entry, index 1 gives a different name
    const second = randomEnglishName((_n) => 1)
    // FIRST_NAMES and LAST_NAMES each have more than one entry, so this must differ
    expect(FIRST_NAMES.length).toBeGreaterThan(1)
    expect(LAST_NAMES.length).toBeGreaterThan(1)
    // At least one of first or last name must change
    const firstParts = first.split(' ')
    const secondParts = second.split(' ')
    expect(firstParts[0] !== secondParts[0] || firstParts[1] !== secondParts[1]).toBe(true)
  })

  it('FIRST_NAMES and LAST_NAMES are non-empty finite arrays', () => {
    expect(FIRST_NAMES.length).toBeGreaterThan(0)
    expect(LAST_NAMES.length).toBeGreaterThan(0)
    // Finite: callers can reason about capacity
    expect(Number.isFinite(FIRST_NAMES.length)).toBe(true)
    expect(Number.isFinite(LAST_NAMES.length)).toBe(true)
  })
})

/**
 * Final review, Important 6. The pool needs three managed people per ACTIVE template and a real
 * catalogue is hundreds of personas -- 278 of them on the installation this was measured against,
 * so 834 names -- all drawn from one globally-unique namespace (`Person.name`, M58 R14). The old
 * dictionaries were 65 x 59 = 3,835 combinations, which is a coupon-collector problem, not a
 * capacity problem: the birthday-style collision rate at 834 draws out of 3,835 is high enough
 * that `syncPersonPool`'s bounded retry can plausibly exhaust on a healthy installation, and the
 * exhaustion is indistinguishable from a bug.
 *
 * The requirement is therefore stated as capacity and pinned here, at the dictionaries, rather
 * than inferred from a passing sync.
 */
describe('the English name dictionaries, as a capacity guarantee', () => {
  it('keeps every legacy dictionary entry so persisted pool names remain valid forever', () => {
    // These entries were accidentally dropped or moved to the wrong half when the dictionaries
    // were expanded. Existing Person rows keep their generated name permanently, so vocabulary
    // expansion must be append-only from the validator's point of view.
    expect(FIRST_NAMES).toContain('Harper')
    for (const surname of ['Garcia', 'Martinez', 'Nelson']) {
      expect(LAST_NAMES).toContain(surname)
    }
    expect(isGeneratedEnglishName('Harper Garcia')).toBe(true)
    expect(isGeneratedEnglishName('Charlotte Nelson')).toBe(true)
  })

  it('offers at least 100,000 distinct First Surname combinations', () => {
    expect(FIRST_NAMES.length).toBeGreaterThanOrEqual(250)
    expect(LAST_NAMES.length).toBeGreaterThanOrEqual(400)
    expect(FIRST_NAMES.length * LAST_NAMES.length).toBeGreaterThanOrEqual(100_000)
  })

  it('holds no duplicate entry in either dictionary, so the combination count is the real one', () => {
    expect(new Set(FIRST_NAMES).size).toBe(FIRST_NAMES.length)
    expect(new Set(LAST_NAMES).size).toBe(LAST_NAMES.length)
  })

  it('holds only single natural name words, so every product is still a "First Surname"', () => {
    // No spaces (the format is one space, between the two halves), no blanks, capitalised, and
    // only the characters an English name carries -- an apostrophe or hyphen is fine, a digit or
    // a comma is a corrupted entry. `isGeneratedEnglishName` splits on the FIRST space and rejects
    // any second one, so an entry with a space in it would be permanently unrecognisable.
    for (const name of [...FIRST_NAMES, ...LAST_NAMES]) {
      expect(name).toMatch(/^[A-Z][A-Za-z'-]+$/u)
    }
  })

  it('is sorted, which is what makes a duplicate visible to whoever edits the list next', () => {
    expect([...FIRST_NAMES]).toEqual([...FIRST_NAMES].toSorted())
    expect([...LAST_NAMES]).toEqual([...LAST_NAMES].toSorted())
  })

  it('round-trips every entry through the validator, at both ends of both lists', () => {
    const firsts = [FIRST_NAMES[0], FIRST_NAMES[FIRST_NAMES.length - 1]]
    const lasts = [LAST_NAMES[0], LAST_NAMES[LAST_NAMES.length - 1]]
    for (const first of firsts) {
      for (const last of lasts) expect(isGeneratedEnglishName(`${String(first)} ${String(last)}`)).toBe(true)
    }
  })
})

describe('isGeneratedEnglishName', () => {
  it('returns true for a name produced by randomEnglishName', () => {
    const name = randomEnglishName((_n) => 0)
    expect(isGeneratedEnglishName(name)).toBe(true)
  })

  it('returns true for any (first, last) pair from the dictionaries', () => {
    expect(isGeneratedEnglishName(`${FIRST_NAMES[0]} ${LAST_NAMES[0]}`)).toBe(true)
    expect(isGeneratedEnglishName(`${FIRST_NAMES[1]} ${LAST_NAMES[1]}`)).toBe(true)
  })

  it('returns false for a name not from the dictionaries', () => {
    expect(isGeneratedEnglishName('NotAFirst NotALast')).toBe(false)
  })

  it('returns false for a name where only the first name is in the dictionary', () => {
    expect(isGeneratedEnglishName(`${FIRST_NAMES[0]} NotALast`)).toBe(false)
  })

  it('returns false for a name where only the last name is in the dictionary', () => {
    expect(isGeneratedEnglishName(`NotAFirst ${LAST_NAMES[0]}`)).toBe(false)
  })

  it('returns false for a single word', () => {
    expect(isGeneratedEnglishName(FIRST_NAMES[0] ?? 'Alice')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isGeneratedEnglishName('')).toBe(false)
  })

  it('returns false for names with extra spaces', () => {
    expect(isGeneratedEnglishName(`${FIRST_NAMES[0]}  ${LAST_NAMES[0]}`)).toBe(false)
  })
})
