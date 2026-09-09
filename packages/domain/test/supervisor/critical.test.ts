import { describe, expect, it } from 'vitest'
import { CRITICAL_PATTERNS, criticalMatches } from '../../src/supervisor/critical.js'

/** One body per pattern key, each written so it fires that key and no other. */
const POSITIVES: Readonly<Record<string, string>> = {
  scope: 'Can we change the scope to include billing as well?',
  permissions: 'Do I need permissions to run the deploy step?',
  secrets: 'Which api key should I use for the upload?',
  spend: 'What is the budget for this milestone?',
  destructive: 'Should I delete the old table before migrating?',
  external: 'Should I email the customer about the delay?',
}

describe('CRITICAL_PATTERNS', () => {
  it('is the six-key lexicon the spec names, with unique keys', () => {
    expect(CRITICAL_PATTERNS.map((entry) => entry.key)).toEqual([
      'scope',
      'permissions',
      'secrets',
      'spend',
      'destructive',
      'external',
    ])
    expect(new Set(CRITICAL_PATTERNS.map((entry) => entry.key)).size).toBe(CRITICAL_PATTERNS.length)
  })

  /**
   * A `g` (or `y`) flagged RegExp carries `lastIndex` between calls, so the SAME body would match on
   * one call and not the next. A lexicon that answers differently the second time it is asked is
   * worse than no lexicon at all -- it would let a critical question through on a retry.
   */
  it('uses no stateful flags', () => {
    for (const { key, pattern } of CRITICAL_PATTERNS) {
      expect(pattern.global, `${key} is global`).toBe(false)
      expect(pattern.sticky, `${key} is sticky`).toBe(false)
    }
  })
})

describe('criticalMatches', () => {
  it.each(Object.entries(POSITIVES))('matches %s and nothing else', (key, body) => {
    expect(criticalMatches(body)).toEqual([key])
  })

  it('says nothing about a benign question', () => {
    expect(criticalMatches('Which port does the local test server listen on?')).toEqual([])
    expect(criticalMatches('')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(criticalMatches('WHICH API KEY SHOULD I USE?')).toEqual(['secrets'])
  })

  it('returns every key that fired, in CRITICAL_PATTERNS order and deduped', () => {
    const body = 'Should I delete the customer records using the admin password?'
    expect(criticalMatches(body)).toEqual(['permissions', 'secrets', 'destructive', 'external'])
  })

  it('answers the same body the same way however often it is asked', () => {
    const body = POSITIVES.secrets!
    expect(criticalMatches(body)).toEqual(criticalMatches(body))
    expect(criticalMatches(body)).toEqual(['secrets'])
  })

  it('matches the plural and inflected spellings of the same word', () => {
    expect(criticalMatches('Who owns the credentials?')).toEqual(['permissions'])
    expect(criticalMatches('Are we deleting the branch?')).toEqual(['destructive'])
    expect(criticalMatches('What are the costs?')).toEqual(['spend'])
  })

  it('does not fire on a word that merely contains a pattern word', () => {
    // "administration" is not "admin", "paypal" is not "pay", "dropdown" is not "drop".
    expect(criticalMatches('Where does the administration dropdown live in paypalette?')).toEqual([])
  })
})
