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
