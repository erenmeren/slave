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

  // Final review, Minor 10: the file's own doc comment says KEY ASCENDING -- which is the order
  // `listCapabilities()` reads the table back in -- and a hand-maintained list drifts out of the
  // order it claims the moment somebody appends a row at the bottom.
  it('is sorted by key ascending, the order the table is read back in', () => {
    const keys = CAPABILITY_SEED.map((record) => record.key)
    expect(keys).toEqual([...keys].sort())
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

  // Task 3: two unambiguous reviewed synonyms, added so `reconcileTemplateCapabilities` has
  // something safe to repair on an already-imported row. Deliberately narrow -- see the next case
  // for the phrases that must NOT join this list.
  it('resolves the two Task 3 seed aliases', () => {
    expect(normaliseCapabilities(['production monitoring'], CAPABILITY_SEED).keys).toEqual(['operations.observability'])
    expect(normaliseCapabilities(['critical css inlining'], CAPABILITY_SEED).keys).toEqual(['frontend.performance'])
  })

  // Task 3: `normaliseCapabilities` stays exact-only. A broad or sentence-length phrase must stay
  // visibly unresolved rather than being guessed into a key an operator never reviewed.
  it('leaves broad or ambiguous phrases unresolved, never guessed into a key', () => {
    const out = normaliseCapabilities(
      [
        'Performance Optimization',
        'Modern Web Technologies',
        'Pipeline Engineering',
        'Business Integration',
        'I have spent my career obsessing over shipping fast, reliable software for teams of every size',
      ],
      CAPABILITY_SEED,
    )
    expect(out.keys).toEqual([])
    expect(out.unresolved).toEqual([
      'Performance Optimization',
      'Modern Web Technologies',
      'Pipeline Engineering',
      'Business Integration',
      'I have spent my career obsessing over shipping fast, reliable software for teams of every size',
    ])
  })
})
