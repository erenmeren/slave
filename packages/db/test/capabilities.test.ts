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

  /**
   * FINAL REVIEW, IMPORTANT 7. A reviewed alias set, added one at a time against the live
   * catalogue's own unresolved values, for rows whose only stored spelling was a form the industry
   * does not actually write. Every one is an EXACT alternative name for exactly one row -- a
   * singular for a plural (`design system`), a spelling variant (`query optimisation`), or the
   * standard term for a row whose label is a house phrasing (`secrets management` for "Secrets and
   * credentials"). `normaliseCapabilities` itself is untouched: still exact key, exact label or
   * exact synonym, still no substrings and no fuzzy matching.
   *
   * What is NOT here is the point. The live catalogue's 279 templates carry 4,003 distinct
   * unresolved values, and only eight of them repeat at all -- `Performance Engineering`,
   * `Performance Optimization`, `Pipeline Engineering`, `Business Integration`, `Content
   * Operations`, `Risk Management Excellence`, `Cross-Framework Identity Federation`, `Advanced
   * Live Commerce Operations` -- every one of which is a broad heading that could sit under three
   * different rows or none. They stay unresolved, and the case below them says so.
   */
  it('resolves the reviewed final-review aliases, each to exactly one row', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      // Not a synonym, and deliberately so: `database.migrations`' own KEY normalises to exactly
      // this, so adding it would have been a dead entry. The case below this one is what said so.
      ['database migrations', 'database.migrations'],
      ['postgres', 'database.postgres'],
      ['query optimisation', 'database.query-performance'],
      ['query optimization', 'database.query-performance'],
      ['design system', 'design.design-systems'],
      ['user experience design', 'design.interaction'],
      ['reference documentation', 'docs.api-reference'],
      ['technical documentation', 'docs.technical-writing'],
      ['developer documentation', 'docs.technical-writing'],
      ['core web vitals', 'frontend.performance'],
      ['unit testing', 'qa.test-automation'],
      ['end-to-end testing', 'qa.test-automation'],
      ['pull request review', 'review.code-review'],
      ['dependency scanning', 'security.dependency-audit'],
      ['secrets management', 'security.secrets'],
    ]
    for (const [text, key] of expected) {
      expect(normaliseCapabilities([text], CAPABILITY_SEED).keys, text).toEqual([key])
    }
  })

  // The aliases are for spellings that were MISSING, not for spellings already covered: a synonym
  // normalising to its own row's key or label (or to a synonym beside it) is dead weight in a
  // hand-maintained list, and the cross-row collision case above cannot catch it because the owner
  // is the same row. `database.postgres` carried exactly one such entry before this pass -- the
  // synonym `postgresql`, which is what its own LABEL already normalises to.
  //
  // The key and the label themselves are exempt: a key like `backend.performance` normalises to
  // the same words as the label "Backend performance" by design, and neither is a hand-added
  // alternative name somebody could have left behind.
  it('carries no synonym a row already answers to through its key, its label or another synonym', () => {
    for (const record of CAPABILITY_SEED) {
      const covered = new Set([normaliseCapabilityText(record.key), normaliseCapabilityText(record.label)])
      const dead: string[] = []
      for (const synonym of record.synonyms) {
        const text = normaliseCapabilityText(synonym)
        if (covered.has(text)) dead.push(synonym)
        else covered.add(text)
      }
      expect(dead, record.key).toEqual([])
    }
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
        // Final review, Important 7: the rest of the live catalogue's repeated unresolved values.
        // Every one is a heading, not a capability, and the alias set above deliberately leaves
        // them alone.
        'Performance Engineering',
        'Content Operations',
        'Risk Management Excellence',
        'Cross-Framework Identity Federation',
        'Advanced Live Commerce Operations',
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
      'Performance Engineering',
      'Content Operations',
      'Risk Management Excellence',
      'Cross-Framework Identity Federation',
      'Advanced Live Commerce Operations',
      'I have spent my career obsessing over shipping fast, reliable software for teams of every size',
    ])
  })
})
