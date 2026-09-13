import { describe, expect, it } from 'vitest'
import { emptyProfileSpec, type ProfileSpec } from '../../src/profile/spec.js'
import {
  CAPABILITY_OVERLAP_JACCARD,
  DUPLICATE_BASES,
  DUPLICATE_BASIS_LABEL,
  DUPLICATE_CLASSES,
  DUPLICATE_CLASS_LABEL,
  DUPLICATE_FACETS,
  DUPLICATE_FACET_LABEL,
  MINHASH_BANDS,
  MINHASH_BAND_ROWS,
  MINHASH_MULTIPLIERS,
  MINHASH_PERMUTATIONS,
  MINHASH_PRIME,
  NEAR_DUPLICATE_JACCARD,
  SHINGLE_WORDS,
  bandKeysOf,
  bodyBandsOf,
  canonicalPersonaText,
  duplicateBasisLabel,
  duplicateClassLabel,
  classifyPair,
  contentHashOf,
  duplicateCountsSchema,
  emptyDuplicateCounts,
  jaccard,
  minhashOf,
  normalisePersona,
  orderedPair,
  parseDuplicateCounts,
  shinglesOf,
  type DuplicateCandidate,
} from '../../src/catalog/duplicate.js'

/** A spec with something in every field the canonical text reads, so a case that changes ONE field
 *  is a case about that field. */
const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave who owns the last mile',
  summary: 'Gets a change out and watches what it does',
  mission: 'Take one change to production at a time',
  runtimeRole: 'engineering',
  capabilities: ['Deployment', 'Observability'],
  expertise: ['Reading a dashboard back to the change that moved it'],
  operatingPrinciples: ['Ship small'],
  constraints: ['You MUST never leave a red test behind'],
  workflow: ['Step 1: write the failing test'],
  deliverables: ['Module boundary note'],
  successCriteria: ['Every commit green'],
  collaborationHints: ['Consult the Gate Verifier before a release'],
  recommendedSkills: ['writing-plans'],
  body: 'You keep a note of every shortcut that cost something.',
  ...over,
})

const candidate = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: 'a',
  name: 'Backend Architect',
  contentSha256: null,
  capabilityKeys: [],
  shingles: new Set<string>(),
  ...over,
})

const setOf = (...values: string[]): ReadonlySet<string> => new Set(values)

describe('the three vocabularies (R4, R5, R6)', () => {
  it('is three classes, four bases and four facets, and no fifth of anything', () => {
    expect(DUPLICATE_CLASSES).toEqual(['exact', 'near', 'overlapping'])
    expect(DUPLICATE_BASES).toEqual(['content_hash', 'name', 'body_shingles', 'capability_keys'])
    expect(DUPLICATE_FACETS).toEqual(['exact', 'near', 'overlapping', 'none'])
  })

  it('gives every member a WORD, so no surface prints a raw member as visible text (ia.md rule 3)', () => {
    for (const member of DUPLICATE_CLASSES) expect(DUPLICATE_CLASS_LABEL[member], member).not.toBe(member)
    for (const member of DUPLICATE_BASES) expect(DUPLICATE_BASIS_LABEL[member], member).not.toBe(member)
    for (const member of DUPLICATE_FACETS) expect(DUPLICATE_FACET_LABEL[member], member).not.toBe(member)
  })

  it('says the class as the first half of a sentence, because the row after it is the second', () => {
    expect(DUPLICATE_CLASS_LABEL).toEqual({
      exact: 'Duplicate of',
      near: 'Similar to',
      overlapping: 'Overlaps',
    })
  })

  it('says the basis as the reason, in words a person can act on', () => {
    expect(DUPLICATE_BASIS_LABEL).toEqual({
      content_hash: 'same persona text',
      name: 'same name',
      body_shingles: 'overlapping text',
      capability_keys: 'overlapping capabilities',
    })
  })

  /**
   * Final wave, minor 12. A drawer and a catalog row index these tables with a value that arrived in
   * a JSON response, and a `Record` over a union says nothing about a value the compiler never saw:
   * a browser holding this bundle against a server that has learned a fourth class printed
   * `undefined` beside a template's name.
   */
  it('answers a WORD for a class or a basis this version does not know, and never `undefined`', () => {
    for (const member of DUPLICATE_CLASSES) expect(duplicateClassLabel(member)).toBe(DUPLICATE_CLASS_LABEL[member])
    for (const member of DUPLICATE_BASES) expect(duplicateBasisLabel(member)).toBe(DUPLICATE_BASIS_LABEL[member])

    // A fourth class and a fifth basis, as a deploy skew would hand them over.
    expect(duplicateClassLabel('transposed')).toBe('Looks like')
    expect(duplicateBasisLabel('embedding')).toBe('a kind of match this version does not know')
    // Never the raw member (R6) and never the word `undefined`, whatever arrives -- an empty string
    // included, which is what an absent field deserialises to.
    for (const unknown of ['transposed', 'embedding', '']) {
      for (const label of [duplicateClassLabel(unknown), duplicateBasisLabel(unknown)]) {
        expect(label).not.toBe(unknown)
        expect(label).not.toContain('undefined')
      }
    }
  })

  it('says the facet as a filter option, `none` included, and never the raw member itself', () => {
    expect(DUPLICATE_FACET_LABEL).toEqual({
      exact: 'duplicates',
      near: 'near duplicates',
      overlapping: 'overlapping capabilities',
      none: 'no signal',
    })
  })
})

describe('the seven constants (R4)', () => {
  it('spells every threshold once, where the detector and the gate both read it', () => {
    expect(SHINGLE_WORDS).toBe(5)
    expect(NEAR_DUPLICATE_JACCARD).toBe(0.8)
    expect(CAPABILITY_OVERLAP_JACCARD).toBe(0.6)
    expect(MINHASH_PERMUTATIONS).toBe(96)
    expect(MINHASH_BANDS).toBe(16)
    expect(MINHASH_BAND_ROWS).toBe(6)
    expect(MINHASH_PRIME).toBe(2_147_483_647)
  })

  it('cuts the signature EXACTLY into its bands, with no row left over', () => {
    expect(MINHASH_BANDS * MINHASH_BAND_ROWS).toBe(MINHASH_PERMUTATIONS)
  })
})

describe('MINHASH_MULTIPLIERS (erratum E7)', () => {
  it('is 96 pairs, one per permutation', () => {
    expect(MINHASH_MULTIPLIERS).toHaveLength(MINHASH_PERMUTATIONS)
  })

  it('keeps every `a` under 2^22, which is what makes `a * h + b` exact in a double', () => {
    for (const [a] of MINHASH_MULTIPLIERS) {
      expect(a, String(a)).toBeGreaterThan(0)
      expect(a, String(a)).toBeLessThan(2 ** 22)
      expect(a % 2, String(a)).toBe(1)
    }
  })

  it('keeps every `b` inside the prime', () => {
    for (const [, b] of MINHASH_MULTIPLIERS) {
      expect(b, String(b)).toBeGreaterThanOrEqual(0)
      expect(b, String(b)).toBeLessThan(MINHASH_PRIME)
    }
  })

  it('is a real permutation table: no `a` twice, so no two rows of the signature are the same function', () => {
    expect(new Set(MINHASH_MULTIPLIERS.map(([a]) => a)).size).toBe(MINHASH_PERMUTATIONS)
  })

  // The whole of erratum E7, as arithmetic rather than as a promise: the worst product this table
  // can ever compute, against the largest integer a double holds exactly.
  it('never leaves the exact-integer range, at its own worst case', () => {
    const worstA = Math.max(...MINHASH_MULTIPLIERS.map(([a]) => a))
    const worstB = Math.max(...MINHASH_MULTIPLIERS.map(([, b]) => b))
    const worst = worstA * (MINHASH_PRIME - 1) + worstB
    expect(Number.isSafeInteger(worst), `${String(worstA)} * ${String(MINHASH_PRIME - 1)} + ${String(worstB)} = ${String(worst)}`).toBe(true)
  })
})

describe('normalisePersona (R1)', () => {
  it('runs three passes and no more: NFC, lower case, whitespace collapsed', () => {
    expect(normalisePersona('  Ships   SMALL,\n\twatches hard  ')).toBe('ships small, watches hard')
  })

  it('folds a decomposed accent onto its composed form, which is what NFC is for', () => {
    // U+0065 U+0301 (e + combining acute) against U+00E9.
    expect(normalisePersona('Café')).toBe(normalisePersona('Café'))
    expect(normalisePersona('Café')).toBe('café')
  })

  it('does NOT strip punctuation, because two personas that differ by a comma are not the same text', () => {
    expect(normalisePersona('ship, then watch')).toBe('ship, then watch')
  })

  it('is idempotent -- the stored hash and a re-derived one cannot drift', () => {
    const once = normalisePersona('  Á  B  ')
    expect(normalisePersona(once)).toBe(once)
  })

  it('answers the empty string for a string of nothing but whitespace', () => {
    expect(normalisePersona(' \n\t ')).toBe('')
  })
})

describe('canonicalPersonaText (R1)', () => {
  it('joins the spec fields in PROFILE_SPEC_FIELDS order, one per line, lists flattened', () => {
    const text = canonicalPersonaText(spec())
    expect(text.split('\n')[0]).toBe('The slave who owns the last mile')
    expect(text).toContain('Deployment\nObservability')
    expect(text.endsWith('You keep a note of every shortcut that cost something.')).toBe(true)
  })

  it('EXCLUDES runtimeRole -- a scheduler label the importer chose is not a word the persona wrote', () => {
    expect(canonicalPersonaText(spec())).not.toContain('engineering')
    expect(canonicalPersonaText(spec({ runtimeRole: 'testing' }))).toBe(canonicalPersonaText(spec()))
  })

  it('EXCLUDES source -- provenance is not the persona (the same import from two catalogs is one persona)', () => {
    const withSource = spec({
      source: {
        repository: 'catalog-one',
        path: 'engineering/steward.md',
        revision: null,
        license: 'MIT',
        importedAt: '2026-09-14T09:00:00.000Z',
        mappingQuality: 'full',
      },
    })
    expect(canonicalPersonaText(withSource)).toBe(canonicalPersonaText(spec()))
  })

  it('is stable field by field: changing one field changes the text, and changing none does not', () => {
    expect(canonicalPersonaText(spec({ mission: 'Something else' }))).not.toBe(canonicalPersonaText(spec()))
    expect(canonicalPersonaText(spec())).toBe(canonicalPersonaText(spec()))
  })
})

describe('contentHashOf (R1)', () => {
  it('is 64 lower-case hex characters -- goalSha256 over the normalised canonical text', () => {
    expect(contentHashOf(spec())).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('is EQUAL across case, whitespace and NFC differences, which is the whole exact class', () => {
    const loud = spec({
      identity: 'THE SLAVE   WHO OWNS THE LAST MILE',
      summary: 'Gets a change out\tand watches what it does',
    })
    expect(contentHashOf(loud)).toBe(contentHashOf(spec()))
  })

  it('is DIFFERENT when one word differs, because a persona that says something else is something else', () => {
    expect(contentHashOf(spec({ mission: 'Take two changes to production at a time' }))).not.toBe(contentHashOf(spec()))
  })

  it('does not depend on the source record or the runtime role', () => {
    expect(contentHashOf(spec({ runtimeRole: 'qa' }))).toBe(contentHashOf(spec()))
  })
})

describe('shinglesOf (R4)', () => {
  it('is every window of five consecutive words', () => {
    expect([...shinglesOf('one two three four five six')]).toEqual([
      'one two three four five',
      'two three four five six',
    ])
  })

  it('gives a body shorter than five words ONE shingle rather than none (R4 says so in words)', () => {
    expect([...shinglesOf('one two three')]).toEqual(['one two three'])
    expect([...shinglesOf('one')]).toEqual(['one'])
  })

  it('gives an empty body an EMPTY set, which is what a row with no profileSpec has', () => {
    expect(shinglesOf('').size).toBe(0)
    expect(shinglesOf('   ').size).toBe(0)
  })

  it('normalises for itself, so the caller may hand it the raw canonical text', () => {
    expect([...shinglesOf('ONE  Two\nthree Four five')]).toEqual(['one two three four five'])
  })

  it('deduplicates a repeated window -- a set, not a list', () => {
    // Ten words are SIX windows, and the sixth ('a b c d e') is the first one again: five.
    expect(shinglesOf('a b c d e a b c d e').size).toBe(5)
  })
})

describe('jaccard (R4)', () => {
  it('is 1 for two equal sets', () => {
    expect(jaccard(setOf('a', 'b'), setOf('b', 'a'))).toBe(1)
  })

  it('is 0 for two DISJOINT sets', () => {
    expect(jaccard(setOf('a'), setOf('b'))).toBe(0)
  })

  it('is the shared over the union', () => {
    expect(jaccard(setOf('a', 'b', 'c'), setOf('b', 'c', 'd'))).toBeCloseTo(2 / 4, 10)
  })

  it('is ZERO for two EMPTY sets, not 1 -- two personas that name no capability are not the same specialist', () => {
    expect(jaccard(setOf(), setOf())).toBe(0)
  })

  it('is 0 when one side is empty', () => {
    expect(jaccard(setOf('a'), setOf())).toBe(0)
  })

  it('is symmetric, which is what lets classifyPair run on the ORDERED pair', () => {
    const a = setOf('a', 'b', 'c')
    const b = setOf('c', 'd')
    expect(jaccard(a, b)).toBe(jaccard(b, a))
  })
})

describe('minhashOf and bandKeysOf (R4)', () => {
  it('answers one value per permutation, every one inside the prime', () => {
    const signature = minhashOf(shinglesOf('the quick brown fox jumps over the lazy dog again and again'))
    expect(signature).toHaveLength(MINHASH_PERMUTATIONS)
    for (const value of signature) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(MINHASH_PRIME)
    }
  })

  it('is DETERMINISTIC across two calls, which is what makes a stored band column re-derivable', () => {
    const text = 'a persona that says one particular thing and then says another particular thing'
    expect(minhashOf(shinglesOf(text))).toEqual(minhashOf(shinglesOf(text)))
  })

  it('does not depend on the order the shingles were inserted -- min is commutative', () => {
    const forwards = new Set(['a b c d e', 'b c d e f', 'c d e f g'])
    const backwards = new Set(['c d e f g', 'b c d e f', 'a b c d e'])
    expect(minhashOf(forwards)).toEqual(minhashOf(backwards))
  })

  it('cuts a signature into sixteen band keys, each naming its own band', () => {
    const keys = bandKeysOf(minhashOf(shinglesOf('one two three four five six seven eight')))
    expect(keys).toHaveLength(MINHASH_BANDS)
    expect(new Set(keys).size).toBe(MINHASH_BANDS)
    for (const [index, key] of keys.entries()) expect(key.startsWith(`${String(index)}:`)).toBe(true)
    expect((keys[0] as string).split(':')[1]?.split('-')).toHaveLength(MINHASH_BAND_ROWS)
  })

  it('refuses a signature that is not 96 values, rather than silently banding a short one', () => {
    expect(() => bandKeysOf([1, 2, 3])).toThrow(/96/u)
  })

  it('SHARES a band key for two texts a person would call near duplicates', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i)}`)
    const a = words.join(' ')
    const b = [...words.slice(0, 54), 'different', 'ending', 'words', 'entirely', 'here', 'now'].join(' ')
    const shared = bandKeysOf(minhashOf(shinglesOf(a))).filter((key) =>
      bandKeysOf(minhashOf(shinglesOf(b))).includes(key),
    )
    expect(shared.length, `bands shared: ${String(shared.length)}`).toBeGreaterThan(0)
  })

  it('shares NO band key for two texts with nothing in common', () => {
    const a = Array.from({ length: 60 }, (_, i) => `alpha${String(i)}`).join(' ')
    const b = Array.from({ length: 60 }, (_, i) => `omega${String(i)}`).join(' ')
    const shared = bandKeysOf(minhashOf(shinglesOf(a))).filter((key) =>
      bandKeysOf(minhashOf(shinglesOf(b))).includes(key),
    )
    expect(shared).toEqual([])
  })

  it('bodyBandsOf is the whole pipeline over one spec, and two equal specs band equally', () => {
    expect(bodyBandsOf(spec())).toEqual(bodyBandsOf(spec()))
    expect(bodyBandsOf(spec())).toHaveLength(MINHASH_BANDS)
  })
})

describe('orderedPair (R5)', () => {
  it('puts the smaller id first, whichever way it is asked', () => {
    expect(orderedPair('b', 'a')).toEqual(['a', 'b'])
    expect(orderedPair('a', 'b')).toEqual(['a', 'b'])
  })

  it('refuses a row paired with itself, which is the one pair that can never be a duplicate', () => {
    expect(() => orderedPair('a', 'a')).toThrow(/itself/u)
  })
})

describe('classifyPair (R4): the five arms, highest class only', () => {
  it('(1) two equal content hashes are exact, basis content_hash, score 1 -- whatever else differs', () => {
    const a = candidate({ id: 'a', name: 'Backend Architect', contentSha256: 'abc', capabilityKeys: ['backend.services'] })
    const b = candidate({ id: 'b', name: 'Server Specialist', contentSha256: 'abc', capabilityKeys: [] })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'content_hash', score: 1 })
  })

  it('(1) a NULL hash on either side never matches, however null the other is', () => {
    const a = candidate({ id: 'a', name: 'One', contentSha256: null })
    const b = candidate({ id: 'b', name: 'Two', contentSha256: null })
    expect(classifyPair(a, b)).toBeNull()
    expect(classifyPair(a, candidate({ id: 'b', name: 'Two', contentSha256: 'abc' }))).toBeNull()
  })

  it('(2) two names equal after normalisation are exact, basis name, score the BODY jaccard', () => {
    const a = candidate({ id: 'a', name: 'Backend  ARCHITECT', shingles: setOf('one two three four five') })
    const b = candidate({ id: 'b', name: 'backend architect', shingles: setOf('one two three four five') })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'name', score: 1 })
  })

  it('(2) a name pair whose bodies share nothing scores 0 and is STILL exact -- the name is the basis', () => {
    const a = candidate({ id: 'a', name: 'Release Steward', shingles: setOf('a b c d e') })
    const b = candidate({ id: 'b', name: 'release  steward', shingles: setOf('v w x y z') })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'name', score: 0 })
  })

  it('(1) beats (2): equal hashes AND equal names is content_hash, because the hash is the stronger claim', () => {
    const a = candidate({ id: 'a', name: 'Same Name', contentSha256: 'h' })
    const b = candidate({ id: 'b', name: 'same name', contentSha256: 'h' })
    expect(classifyPair(a, b)?.basis).toBe('content_hash')
  })

  it('(3) a body jaccard at or above 0.8 is near, basis body_shingles, score the jaccard to three places', () => {
    const shared = Array.from({ length: 8 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set([...shared, 'x']) })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set([...shared, 'y']) })
    // 8 shared of 10 union = 0.8, exactly ON the threshold, which is inclusive.
    expect(classifyPair(a, b)).toEqual({ class: 'near', basis: 'body_shingles', score: 0.8 })
  })

  it('(3) just UNDER the threshold is not near', () => {
    const shared = Array.from({ length: 7 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set([...shared, 'x']) })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set([...shared, 'y', 'z']) })
    // 7 shared of 10 union = 0.7.
    expect(classifyPair(a, b)).toBeNull()
  })

  it('(4) a capability jaccard at or above 0.6 is overlapping, basis capability_keys', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['backend.services', 'backend.api-design', 'database.postgres'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['backend.services', 'backend.api-design', 'database.postgres'] })
    expect(classifyPair(a, b)).toEqual({ class: 'overlapping', basis: 'capability_keys', score: 1 })
  })

  it('(4) 4 of 5 shared is overlapping and scores 0.667 -- four over a union of six', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k9'] })
    expect(classifyPair(a, b)).toEqual({ class: 'overlapping', basis: 'capability_keys', score: 0.667 })
  })

  it('(4) 2 of 5 shared is BELOW the threshold and classifies as nothing', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k7', 'k8', 'k9'] })
    expect(classifyPair(a, b)).toBeNull()
  })

  it('(4) two empty capability lists are NOT overlapping, because jaccard of two empty sets is 0', () => {
    expect(classifyPair(candidate({ id: 'a', name: 'One' }), candidate({ id: 'b', name: 'Two' }))).toBeNull()
  })

  it('(3) beats (4): a near body wins over a full capability overlap, which is what "highest class" means', () => {
    const shared = Array.from({ length: 9 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set(shared), capabilityKeys: ['k1'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set(shared), capabilityKeys: ['k1'] })
    expect(classifyPair(a, b)?.class).toBe('near')
  })

  it('(5) two rows with nothing in common classify as nothing at all', () => {
    const a = candidate({ id: 'a', name: 'One', shingles: setOf('a b c d e'), capabilityKeys: ['k1'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: setOf('v w x y z'), capabilityKeys: ['k2'] })
    expect(classifyPair(a, b)).toBeNull()
  })

  it('is SYMMETRIC -- the verdict does not depend on which row the writer put first', () => {
    const a = candidate({ id: 'a', name: 'One', shingles: setOf('a b c d e', 'b c d e f'), capabilityKeys: ['k1', 'k2'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: setOf('a b c d e'), capabilityKeys: ['k1', 'k2'] })
    expect(classifyPair(a, b)).toEqual(classifyPair(b, a))
  })

  it('rounds every score to three decimals, so the stored number IS the number the label prints', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k3', 'k4'] })
    const verdict = classifyPair(a, b)
    expect(verdict?.score).toBe(0.75)
    expect(String(verdict?.score).replace(/^\d+\.?/u, '')).toHaveLength(2)
  })
})

describe('DuplicateCounts (R7)', () => {
  it('starts at zero for every class, so a report always carries three numbers', () => {
    expect(emptyDuplicateCounts()).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })

  it('accepts the shape a CatalogImport.report Json column carries', () => {
    expect(duplicateCountsSchema.safeParse({ exact: 3, near: 3, overlapping: 12 }).success).toBe(true)
  })

  it('refuses a fourth class, a negative count and a fractional one -- this is a row count', () => {
    expect(duplicateCountsSchema.safeParse({ exact: 1, near: 1, overlapping: 1, merged: 1 }).success).toBe(false)
    expect(duplicateCountsSchema.safeParse({ exact: -1, near: 0, overlapping: 0 }).success).toBe(false)
    expect(duplicateCountsSchema.safeParse({ exact: 1.5, near: 0, overlapping: 0 }).success).toBe(false)
  })

  it('parses a stored column back, and answers ZEROES for one written before this milestone', () => {
    expect(parseDuplicateCounts({ exact: 1, near: 2, overlapping: 3 })).toEqual({ exact: 1, near: 2, overlapping: 3 })
    expect(parseDuplicateCounts(undefined)).toEqual({ exact: 0, near: 0, overlapping: 0 })
    expect(parseDuplicateCounts({ created: [] })).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })
})
