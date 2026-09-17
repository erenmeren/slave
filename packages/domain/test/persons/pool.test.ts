import { describe, expect, it } from 'vitest'
import { FIRST_NAMES, LAST_NAMES, isGeneratedEnglishName, randomEnglishName } from '../../src/persons/pool.js'

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
