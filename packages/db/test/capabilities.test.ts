import { CAPABILITY_KEY_PATTERN, normaliseCapabilities, normaliseCapabilityText } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_SEED } from '../src/capabilities.js'

/**
 * The shipped taxonomy is DATA (M47 R1), and data that is wrong is wrong everywhere at once: a key
 * that does not match the pattern can never be written by the CLI, a duplicated key silently loses
 * a row to `createMany`, and two rows sharing a normalised spelling make `normaliseCapabilities`
 * depend on seed order -- which is the one thing that module promises it does not.
 */
describe('CAPABILITY_SEED', () => {
  it('is 48 rows over 13 domains', () => {
    expect(CAPABILITY_SEED).toHaveLength(48)
    expect(new Set(CAPABILITY_SEED.map((record) => record.domain)).size).toBe(13)
  })

  it('has a unique key on every row, in the <domain>.<name> shape', () => {
    expect(new Set(CAPABILITY_SEED.map((record) => record.key)).size).toBe(CAPABILITY_SEED.length)
    for (const record of CAPABILITY_SEED) {
      expect(CAPABILITY_KEY_PATTERN.test(record.key), record.key).toBe(true)
    }
  })

  it("stores each key's own prefix as its domain, so a facet list is a groupBy", () => {
    for (const record of CAPABILITY_SEED) {
      expect(record.key.split('.')[0], record.key).toBe(record.domain)
    }
  })

  it('gives every row a label and a role -- a row with neither is unrenderable and undispatchable', () => {
    for (const record of CAPABILITY_SEED) {
      expect(record.label.length, record.key).toBeGreaterThan(0)
      expect(record.role.length, record.key).toBeGreaterThan(0)
    }
  })

  it('shares no normalised spelling between two rows', () => {
    const owner = new Map<string, string>()
    const collisions: string[] = []
    for (const record of CAPABILITY_SEED) {
      for (const spelling of [record.key, record.label, ...record.synonyms]) {
        const text = normaliseCapabilityText(spelling)
        const existing = owner.get(text)
        if (existing !== undefined && existing !== record.key) collisions.push(`"${text}": ${existing} and ${record.key}`)
        else owner.set(text, record.key)
      }
    }
    expect(collisions).toEqual([])
  })

  // Fix round 1: `CI/CD` normalised to `cicd` and the row had no spelling that could match it, so
  // the most common spelling of the most common operations capability resolved to nothing.
  it('resolves both spellings of CI/CD', () => {
    expect(normaliseCapabilities(['CI/CD', 'ci-cd', 'CICD'], CAPABILITY_SEED).keys).toEqual(['operations.ci-cd'])
  })
})
