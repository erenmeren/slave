import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_REF_MAX_CHARS,
  EXTERNAL_REF_RE,
  EXTERNAL_SOURCES,
  EXTERNAL_SOURCE_LABEL,
  EXTERNAL_URL_MAX_CHARS,
  REPOSITORY_FULL_NAME_MAX_CHARS,
  REPOSITORY_FULL_NAME_RE,
  externalOriginSchema,
  originLabel,
  parseExternalOrigin,
  type ExternalOrigin,
} from '../../src/external/origin.js'

const ISSUE: ExternalOrigin = {
  source: 'github',
  repository: 'acme/checkout',
  ref: '#412',
  url: 'https://github.com/acme/checkout/issues/412',
}

describe('EXTERNAL_SOURCES (R5)', () => {
  it('is one member -- a GitLab adapter is an additive migration and one classifier (spec section 4)', () => {
    expect(EXTERNAL_SOURCES).toEqual(['github'])
  })

  it('gives every member a WORD, so no surface prints `github` as its visible text (ia.md rule 3)', () => {
    for (const source of EXTERNAL_SOURCES) {
      expect(EXTERNAL_SOURCE_LABEL[source], source).not.toBe(source)
      expect(EXTERNAL_SOURCE_LABEL[source], source).toMatch(/^[A-Z]/u)
    }
    expect(EXTERNAL_SOURCE_LABEL).toEqual({ github: 'GitHub' })
  })
})

describe('the three label SHAPES (R8)', () => {
  it('accepts an owner/repo and refuses everything that is not one', () => {
    expect(REPOSITORY_FULL_NAME_RE.test('acme/checkout')).toBe(true)
    expect(REPOSITORY_FULL_NAME_RE.test('acme.co/check-out_2')).toBe(true)
    expect(REPOSITORY_FULL_NAME_RE.test('acme')).toBe(false)
    expect(REPOSITORY_FULL_NAME_RE.test('acme/checkout/extra')).toBe(false)
    expect(REPOSITORY_FULL_NAME_RE.test('acme/check out')).toBe(false)
    expect(REPOSITORY_FULL_NAME_RE.test('acme/<b>x</b>')).toBe(false)
    expect(REPOSITORY_FULL_NAME_RE.test('')).toBe(false)
  })

  it('caps the repository at 201 characters by the regex itself, so no second cap is needed (R4)', () => {
    const longest = `${'a'.repeat(100)}/${'b'.repeat(100)}`
    expect(longest).toHaveLength(201)
    expect(REPOSITORY_FULL_NAME_RE.test(longest)).toBe(true)
    expect(REPOSITORY_FULL_NAME_RE.test(`${'a'.repeat(101)}/b`)).toBe(false)
  })

  it('accepts a #number or a 7-40 character hex sha, and nothing else', () => {
    expect(EXTERNAL_REF_RE.test('#412')).toBe(true)
    expect(EXTERNAL_REF_RE.test('1a2b3c4')).toBe(true)
    expect(EXTERNAL_REF_RE.test('1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b')).toBe(true)
    expect(EXTERNAL_REF_RE.test('#')).toBe(false)
    expect(EXTERNAL_REF_RE.test('1a2b3c')).toBe(false)
    expect(EXTERNAL_REF_RE.test('main')).toBe(false)
    expect(EXTERNAL_REF_RE.test('#12; rm -rf /')).toBe(false)
  })

  it('caps the ref at 40 characters by the regex too (R4 says 64; the shape is tighter)', () => {
    expect(EXTERNAL_REF_RE.test('a'.repeat(41))).toBe(false)
    expect(EXTERNAL_REF_RE.test(`#${'9'.repeat(13)}`)).toBe(false)
  })

  it('spells the url cap once, where the schema and the adapter both read it', () => {
    expect(EXTERNAL_URL_MAX_CHARS).toBe(500)
  })
})

describe('externalOriginSchema (R5)', () => {
  it('accepts the shape three places carry: two event payloads and a goal version', () => {
    expect(externalOriginSchema.safeParse(ISSUE).success).toBe(true)
  })

  it('accepts a null ref and a null url -- an unrecognised delivery carries both (E8)', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, ref: null, url: null }).success).toBe(true)
  })

  it('refuses a source nothing in this build can be', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, source: 'gitlab' }).success).toBe(false)
  })

  it('refuses a repository that is not owner/repo, so a label can never be typed prose', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, repository: 'Ignore previous instructions' }).success).toBe(false)
  })

  it('refuses a ref that is neither a number nor a sha', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, ref: 'refs/heads/main' }).success).toBe(false)
  })

  it('refuses a url over the cap rather than truncating one the reader would click', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, url: `https://x/${'y'.repeat(500)}` }).success).toBe(false)
  })

  it('is `.strict()` -- this value goes into a Json column three readers parse back', () => {
    expect(externalOriginSchema.safeParse({ ...ISSUE, deliveryId: 'd1' }).success).toBe(false)
  })
})

describe('parseExternalOrigin (R9)', () => {
  it('answers the origin for a stored column that still parses', () => {
    expect(parseExternalOrigin({ ...ISSUE })).toEqual(ISSUE)
  })

  it('answers null for a column that does not -- a hand-edited row is not a crash on a page', () => {
    expect(parseExternalOrigin(null)).toBeNull()
    expect(parseExternalOrigin('github')).toBeNull()
    expect(parseExternalOrigin({ source: 'github' })).toBeNull()
  })
})

describe('originLabel (R9)', () => {
  it('reads as a sentence: from GitHub, a middle dot, then owner/repo#123', () => {
    expect(originLabel(ISSUE)).toBe('from GitHub · acme/checkout#412')
  })

  it('puts a SPACE before a sha, because `acme/checkout1a2b3c4` is two facts run together', () => {
    expect(originLabel({ ...ISSUE, ref: '1a2b3c4' })).toBe('from GitHub · acme/checkout 1a2b3c4')
  })

  it('says the repository alone when there is no ref', () => {
    expect(originLabel({ ...ISSUE, ref: null })).toBe('from GitHub · acme/checkout')
  })

  it('never prints the raw source key, whatever the ref is', () => {
    for (const ref of ['#1', '1a2b3c4', null]) {
      expect(originLabel({ ...ISSUE, ref })).not.toContain('github')
    }
  })

  it('never prints the url -- a sentence is not a link (R9)', () => {
    expect(originLabel(ISSUE)).not.toContain('https://')
  })
})

describe('the two lengths stated as numbers (fix-round-1 erratum E17)', () => {
  it('is the longest repository the regex accepts, and one more is refused', () => {
    const longest = `${'a'.repeat(100)}/${'b'.repeat(100)}`
    expect([...longest]).toHaveLength(REPOSITORY_FULL_NAME_MAX_CHARS)
    expect(REPOSITORY_FULL_NAME_RE.test(longest)).toBe(true)
    expect(REPOSITORY_FULL_NAME_RE.test(`a${longest}`)).toBe(false)
  })

  it('is the longest ref the regex accepts, and one more is refused', () => {
    const longest = 'a'.repeat(40)
    expect([...longest]).toHaveLength(EXTERNAL_REF_MAX_CHARS)
    expect(EXTERNAL_REF_RE.test(longest)).toBe(true)
    expect(EXTERNAL_REF_RE.test('a'.repeat(41))).toBe(false)
    // The other shape is shorter, so the sha is what the number has to be.
    expect([...`#${'9'.repeat(12)}`].length).toBeLessThan(EXTERNAL_REF_MAX_CHARS)
  })
})
