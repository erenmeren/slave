import { z } from 'zod'
import { goalSha256 } from '../goal/version.js'
import { PROFILE_SPEC_FIELDS, type ProfileSpec, type ProfileSpecField } from '../profile/spec.js'

/**
 * "Are these two catalog rows the same specialist?" -- the three classes, the four bases, and the
 * six pure functions that answer it (M55 R1, R4, R5, R6).
 *
 * PURE, and it must stay that way: `packages/domain` is imported by `apps/web`'s CLIENT bundle, so
 * there is no `node:crypto`, no `node:fs` and no Prisma anywhere in this graph. `goalSha256`
 * (`../goal/version.ts`) is the hand-rolled SHA-256 that exists for exactly this reason, and its
 * own docblock records the measured `web:build` failure that made it necessary.
 *
 * NOTHING HERE DECIDES ANYTHING. These functions describe a pair; `packages/control/src/
 * duplicates.ts` is what writes a row, and `deleteSlaveTemplate` is still the only thing in this
 * product that removes a template. The signal never deletes -- a person may dismiss it, the
 * importer may not (R5).
 */

/** The three classes, strongest first, which is also `classifyPair`'s arm order (R4). */
export const DUPLICATE_CLASSES = ['exact', 'near', 'overlapping'] as const

export type DuplicateClass = (typeof DUPLICATE_CLASSES)[number]

/** WHY a pair classified -- the column M53 R1's rule (and M54 R4's own two) asks for: a surface
 *  must be able to answer a question without a join or a guess, and "these two are the same" reads
 *  completely differently from "these two are spelled the same". */
export const DUPLICATE_BASES = ['content_hash', 'name', 'body_shingles', 'capability_keys'] as const

export type DuplicateBasis = (typeof DUPLICATE_BASES)[number]

/** The catalog filter's vocabulary (R3/R6). `none` is a real answer -- "show me the rows nothing
 *  was noticed about" -- and `any` is NOT a member: the absence of the filter is what "any" means,
 *  and a member for it would be a second spelling of an empty value. */
export const DUPLICATE_FACETS = ['exact', 'near', 'overlapping', 'none'] as const

export type DuplicateFacet = (typeof DUPLICATE_FACETS)[number]

/** The first half of a sentence whose second half is the other template's NAME: `Duplicate of
 *  Backend Architect` (`docs/ia.md` rule 3). A `Record` over the union, so a fourth class fails the
 *  build here rather than turning up on a chip as an identifier. */
export const DUPLICATE_CLASS_LABEL: Record<DuplicateClass, string> = {
  exact: 'Duplicate of',
  near: 'Similar to',
  overlapping: 'Overlaps',
}

/** What goes in the chip's `title` after the class: `same persona text`, `same name`. The raw
 *  member stays on `data-basis`. */
export const DUPLICATE_BASIS_LABEL: Record<DuplicateBasis, string> = {
  content_hash: 'same persona text',
  name: 'same name',
  body_shingles: 'overlapping text',
  capability_keys: 'overlapping capabilities',
}

/**
 * The two labels for a class and a basis that arrived off the WIRE (final wave, minor 12).
 *
 * Both `Record`s above are total over the union the COMPILER checked and say nothing about a value
 * it did not: a drawer and a catalog row read their pairs out of a JSON response, so a browser
 * still holding this bundle against a server that has learned a fourth class would index the table
 * with it and print `undefined` beside a template's name. These answer a word for anything the
 * enums do not hold -- and never the raw member, which is R6's rule either way.
 */
export function duplicateClassLabel(value: string): string {
  return (DUPLICATE_CLASSES as readonly string[]).includes(value)
    ? DUPLICATE_CLASS_LABEL[value as DuplicateClass]
    : 'Looks like'
}

export function duplicateBasisLabel(value: string): string {
  return (DUPLICATE_BASES as readonly string[]).includes(value)
    ? DUPLICATE_BASIS_LABEL[value as DuplicateBasis]
    : 'a kind of match this version does not know'
}

/** What the filter's `<option>` says. The `<option value>` is the raw member, which is what a gate
 *  reads; this is what a person reads.
 *
 *  `overlapping` says `overlapping capabilities` and NOT `overlapping`: R6's own sentence is that no
 *  surface prints `exact`, `near`, `overlapping`, `content_hash` or `capability_keys` as visible
 *  text, and a label identical to its member is that member printed. It also says what the class
 *  actually is -- arm (4) is the only arm that produces `overlapping`, and its basis is always
 *  `capability_keys`, so the option names the one thing such a pair shares. */
export const DUPLICATE_FACET_LABEL: Record<DuplicateFacet, string> = {
  exact: 'duplicates',
  near: 'near duplicates',
  overlapping: 'overlapping capabilities',
  none: 'no signal',
}

/** A shingle is five consecutive words. Five is the classic near-duplicate window: three matches
 *  too much ordinary English, ten misses a paragraph somebody reordered. */
export const SHINGLE_WORDS = 5

/** At or above this body Jaccard, two personas are the `near` class (R4). Inclusive, so a pair
 *  sitting exactly on it is a signal rather than an accident of rounding. */
export const NEAR_DUPLICATE_JACCARD = 0.8

/** At or above this `capabilityKeys` Jaccard, two personas `overlap` -- they claim the same work
 *  without being the same text (R4). Inclusive, for the same reason. */
export const CAPABILITY_OVERLAP_JACCARD = 0.6

export const MINHASH_PERMUTATIONS = 96
export const MINHASH_BANDS = 16
export const MINHASH_BAND_ROWS = 6

/** 2^31 - 1, the largest signed 32-bit integer and a Mersenne prime, so every reduced value fits a
 *  Postgres `integer` and the band strings stay short. */
export const MINHASH_PRIME = 2_147_483_647

/**
 * The 96 `(a, b)` pairs of the universal hash family `h(x) = (a * x + b) mod MINHASH_PRIME`.
 *
 * **Why `a` is bounded at 2^22** (plan erratum E7). `x` here is a shingle's FNV-1a already reduced
 * `mod MINHASH_PRIME`, so `x < 2^31`. JavaScript has no integer type: every product above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) rounds silently, and a rounded permutation is the worst bug
 * this module could carry -- deterministic, never throwing, and quietly turning a detector into a
 * coin. With `a <= 4_194_303` (2^22 - 1) and `b < MINHASH_PRIME` the worst possible value of
 * `a * x + b` is
 *
 *     4_194_303 * 2_147_483_646 + 2_147_483_646 = 9_007_199_246_352_384
 *
 * against `Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991`. Exact, with 8_388_607 to spare. (The
 * plan's own erratum E7 wrote that product one too high, which is exactly why the test beside this
 * file RECOMPUTES both numbers rather than trusting a comment -- including this one.)
 *
 * Every `a` is ODD and every `a` is distinct, so no two rows of the signature are the same
 * function of `x`. Generated once by a seeded xorshift and CHECKED IN rather than computed at load:
 * a table built by a second algorithm is a second algorithm to keep correct, and this one must
 * produce byte-identical `bodyBands` across every process that ever writes the column.
 */
export const MINHASH_MULTIPLIERS: readonly (readonly [number, number])[] = [
  [3169017, 1586090227], [2613573, 382380497],
  [2741775, 232615630], [1781461, 1244294101],
  [643839, 1676914052], [2620527, 747570422],
  [2490601, 1103821344], [2359799, 1022641961],
  [3578763, 1204796106], [195135, 2126723562],
  [3201407, 604721943], [1536139, 1177788207],
  [1762299, 1123341501], [4863, 1897762844],
  [1067903, 1029735205], [975371, 1709932376],
  [3840561, 497789058], [291675, 382994347],
  [311221, 1787336164], [3218479, 1386870950],
  [1631573, 22012615], [3448941, 1684765290],
  [2485241, 765698339], [3823313, 1267615779],
  [479125, 1426103295], [1328949, 805585094],
  [478869, 888399543], [96669, 712835973],
  [3227759, 1086925557], [2148887, 1400695186],
  [1261267, 1932300089], [3963081, 359817468],
  [1329797, 1926896944], [3978689, 114507509],
  [3410235, 1459514635], [3628909, 1548287645],
  [3446683, 1770408864], [182835, 870372881],
  [3332419, 871743346], [2888441, 583643136],
  [4128139, 929673685], [3227907, 288991724],
  [1566849, 1369175855], [3306937, 1383001508],
  [773895, 330496915], [1510799, 537543138],
  [3454445, 265894411], [1149299, 1676215205],
  [3002701, 810653262], [1482997, 1831101848],
  [3524893, 1995326011], [703419, 242934337],
  [3113293, 1761263402], [2358881, 1845732277],
  [1624393, 621986839], [2041051, 1546267841],
  [4090745, 280439893], [209803, 1505547793],
  [2098279, 836203356], [3912711, 1783840186],
  [2824857, 929890554], [3624687, 985019919],
  [177173, 1305714399], [540817, 1932759127],
  [1534837, 795863931], [1101333, 2101777601],
  [166625, 523752610], [1774151, 712987483],
  [1203313, 1051978764], [3932407, 154352923],
  [1911051, 200459198], [2123683, 1549907028],
  [2068099, 592423064], [3218433, 1395592744],
  [2148409, 2144566435], [2747337, 596590943],
  [3956259, 111416258], [1706953, 631439206],
  [937165, 578877185], [3510645, 870985946],
  [1847697, 227625199], [1832967, 1438635133],
  [3688659, 340777422], [3907817, 1099332262],
  [618053, 2014548429], [2152883, 91165302],
  [1416525, 647080639], [152579, 1638565780],
  [1007645, 1539608277], [1521425, 390899833],
  [3573235, 1430521830], [2700473, 984044652],
  [4013403, 299069586], [2156433, 1662744306],
  [2561269, 839525639], [3488705, 731489162],
]

/**
 * The fields the canonical persona text is built from: `PROFILE_SPEC_FIELDS` in that constant's own
 * order, minus `runtimeRole` (M55 R1).
 *
 * `runtimeRole` is out because it is a scheduler label the IMPORTER chose from a directory name, not
 * a word the persona wrote -- two copies of one persona filed under two divisions are one persona.
 * `source` is out for free: it is not a member of `PROFILE_SPEC_FIELDS` at all
 * (`../profile/spec.ts:84`), which is the same exclusion `PROFILE_SECTION_PRIORITY` makes for the
 * same reason.
 */
const CANONICAL_FIELDS: readonly ProfileSpecField[] = PROFILE_SPEC_FIELDS.filter(
  (field) => field !== 'runtimeRole',
)

/**
 * The text two catalog rows are compared AS (M55 R1).
 *
 * Not the persona FILE and not `SlaveTemplate.profile`. The file carries front matter -- `color`,
 * `emoji`, `vibe` -- which M42 R4 already calls cosmetics, and `profile` is
 * `renderProfileSpec(...)`, which OPENS with `importedProfilePrefix(sourceId, importedAt)`
 * (`./persona.ts:89-91`): a line carrying the source id and the DAY, so the same persona imported
 * from two catalogs on two days could never hash equal. The structured fields are what is left when
 * both of those are gone, and they are reproducible from a stored column -- which is what lets
 * `template duplicates --recompute` re-derive this for a row whose file is long gone.
 *
 * A list renders one item per line, the same way `sectionText` does, so a persona that moved a
 * sentence from a paragraph into a bullet still hashes and shingles as the same words.
 */
export function canonicalPersonaText(spec: ProfileSpec): string {
  const parts: string[] = []
  for (const field of CANONICAL_FIELDS) {
    const value = spec[field]
    parts.push(typeof value === 'string' ? value : value.join('\n'))
  }
  return parts.join('\n')
}

/**
 * Three passes and no more (M55 R1): **NFC**, **lower case**, **every run of whitespace collapsed
 * to one space**, then trimmed.
 *
 * Punctuation SURVIVES, deliberately: two personas that differ by a comma are two different texts,
 * and a normaliser that threw punctuation away would make the `exact` class claim more than it can
 * prove. NFC rather than NFKC for the same reason -- NFKD would fold a ligature and a superscript
 * into things their author did not write.
 *
 * Idempotent, which is what makes a stored `contentSha256` and a re-derived one incapable of
 * drifting.
 */
export function normalisePersona(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** The cross-catalog identity of a persona (M55 R1): `goalSha256` of the normalised canonical text.
 *  DELIBERATELY NOT UNIQUE on the column -- two rows holding the same persona are exactly the fact
 *  this milestone exists to SHOW, and a unique index would turn showing it into refusing the second
 *  import. */
export function contentHashOf(spec: ProfileSpec): string {
  return goalSha256(normalisePersona(canonicalPersonaText(spec)))
}

/**
 * The set of five-word windows over a text (M55 R4).
 *
 * Normalises for itself, so a caller may hand it the raw canonical text and cannot forget to. A
 * body SHORTER than five words yields ONE shingle -- the whole body -- rather than none, because a
 * two-line persona that is copied verbatim is still a duplicate and an empty set would make it
 * invisible. An EMPTY body yields an empty set, which is what a row with no `profileSpec` has, and
 * `jaccard` answers 0 for it.
 */
export function shinglesOf(text: string): ReadonlySet<string> {
  const words = normalisePersona(text).split(' ').filter((word) => word !== '')
  if (words.length === 0) return new Set()
  if (words.length <= SHINGLE_WORDS) return new Set([words.join(' ')])
  const out = new Set<string>()
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(' '))
  }
  return out
}

/**
 * FNV-1a, 32-bit, over a string's UTF-16 units byte by byte.
 *
 * `Math.imul` rather than `*`: the multiplication is defined modulo 2^32 and a plain `*` would
 * produce a double past 2^53 within three characters. Both bytes of each unit are folded, so two
 * strings differing only above U+00FF cannot collide by construction.
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    hash = Math.imul(hash ^ (unit & 0xff), 0x01000193)
    hash = Math.imul(hash ^ (unit >>> 8), 0x01000193)
  }
  return hash >>> 0
}

/**
 * The 96-value MinHash signature of a shingle set (M55 R4).
 *
 * An EMPTY set answers 96 copies of `MINHASH_PRIME` -- the identity of `min` -- so two rows with no
 * body share every band key and become candidates for each other. That is not a bug and it is not a
 * signal either: `classifyPair` then computes their exact Jaccard, which is 0 for two empty sets,
 * and answers `null`. The banding is a FILTER; the classification is the answer.
 *
 * Independent of the order the shingles were inserted, because `min` is commutative -- which is
 * what makes the stored `bodyBands` column re-derivable by any process in any order.
 */
export function minhashOf(shingles: ReadonlySet<string>): readonly number[] {
  const signature: number[] = new Array<number>(MINHASH_PERMUTATIONS).fill(MINHASH_PRIME)
  for (const shingle of shingles) {
    // Reduced FIRST, which is what makes `base < MINHASH_PRIME` true rather than hoped for, and
    // therefore what makes the bound in `MINHASH_MULTIPLIERS`' docblock hold (erratum E7).
    const base = fnv1a32(shingle) % MINHASH_PRIME
    for (let permutation = 0; permutation < MINHASH_PERMUTATIONS; permutation += 1) {
      const pair = MINHASH_MULTIPLIERS[permutation] as readonly [number, number]
      const value = (pair[0] * base + pair[1]) % MINHASH_PRIME
      if (value < (signature[permutation] as number)) signature[permutation] = value
    }
  }
  return signature
}

/**
 * The signature, cut into `MINHASH_BANDS` keys of `MINHASH_BAND_ROWS` values each (M55 R4).
 *
 * Two rows are CANDIDATES for each other exactly when they share one of these strings. At a true
 * Jaccard of 0.9 that happens with probability 1 - (1 - 0.9^6)^16 ~ 0.999995; at 0.8 (the `near`
 * threshold) ~ 0.992; at 0.3 ~ 0.012 -- so a five-thousand-row catalog yields on the order of sixty
 * candidate pairs per row and not six hundred, which is the bound `DUPLICATE_CANDIDATES_MAX` is
 * sized against rather than clipping real work.
 *
 * The band INDEX is part of the key, so band 0's six values cannot collide with band 3's.
 */
export function bandKeysOf(signature: readonly number[]): readonly string[] {
  if (signature.length !== MINHASH_PERMUTATIONS) {
    throw new Error(`bandKeysOf: a signature is ${String(MINHASH_PERMUTATIONS)} values, got ${String(signature.length)}`)
  }
  const keys: string[] = []
  for (let band = 0; band < MINHASH_BANDS; band += 1) {
    const start = band * MINHASH_BAND_ROWS
    keys.push(`${String(band)}:${signature.slice(start, start + MINHASH_BAND_ROWS).join('-')}`)
  }
  return keys
}

/** The whole pipeline over one spec: what `SlaveTemplate.bodyBands` holds. ONE column rather than
 *  two (R4): the band keys ARE the signature re-encoded, and "do these two rows share a band" is
 *  the only question anything asks of it -- which a list of 96 integers could not answer without a
 *  second derived column holding exactly these strings. */
export function bodyBandsOf(spec: ProfileSpec): readonly string[] {
  return bandKeysOf(minhashOf(shinglesOf(canonicalPersonaText(spec))))
}

/**
 * |A n B| / |A u B|, and **0 for two empty sets** (M55 R4).
 *
 * Not 1. Two personas that name no capability are not thereby the same specialist, and two rows
 * with no `profileSpec` are not thereby the same persona -- the mathematical convention for the
 * empty-over-empty case is a convention, and this is the one place where choosing it wrongly would
 * make the detector claim something nobody can defend.
 *
 * Iterates the SMALLER set, so a five-thousand-shingle persona against a twenty-shingle one costs
 * twenty lookups rather than five thousand.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** Three decimals, at WRITE time (R4), so the number stored on the row is exactly the number a
 *  label prints and exactly the number a test compares -- never a float whose last place differs
 *  between the writer and the reader. */
function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * `aId < bId`, the WRITER's rule (M55 R5), enforced by this one helper every write path goes
 * through.
 *
 * Not a database CHECK constraint, however much it wants to be one: M42 erratum E23 makes the
 * migration proof `prisma migrate diff --from-config-datasource --to-schema ...` -> "No difference
 * detected", and a constraint hand-added to the migration SQL that the Prisma schema cannot express
 * is precisely a difference that proof would report forever. A unit test and the gate hold the rule
 * instead.
 */
export function orderedPair(x: string, y: string): readonly [string, string] {
  if (x === y) throw new Error('orderedPair: a template is never a duplicate of itself')
  return x < y ? [x, y] : [y, x]
}

/** One row as the detector reads it: the projection, plus the shingle set derived from its spec.
 *  `shingles` is EMPTY for a row with no `profileSpec`, which is what makes such a row take part in
 *  the name and capability arms and in neither of the two text arms (R1). */
export interface DuplicateCandidate {
  readonly id: string
  readonly name: string
  readonly contentSha256: string | null
  readonly capabilityKeys: readonly string[]
  readonly shingles: ReadonlySet<string>
}

/** The pair's HIGHEST class and nothing else (R4): one class, one basis, one score. There is no
 *  "overall" number and there is no second-place class -- a row showing two verdicts about the same
 *  pair would be two answers to one question. */
export interface DuplicateVerdict {
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
}

/**
 * The five arms, in order, highest class first (M55 R4).
 *
 *   1. both `contentSha256` non-null and equal -> `exact`, basis `content_hash`, score 1
 *   2. equal NORMALISED names                  -> `exact`, basis `name`, score the body Jaccard
 *   3. body Jaccard >= NEAR_DUPLICATE_JACCARD  -> `near`, basis `body_shingles`
 *   4. capability Jaccard >= CAPABILITY_OVERLAP_JACCARD -> `overlapping`, basis `capability_keys`
 *   5. otherwise                               -> null
 *
 * Arm (4) needs no "different names" test of its own: arm (2) has already claimed every equal-name
 * pair, which is what "highest class only" means operationally.
 *
 * Arm (2) can only ever fire on names that differ AS BYTES and agree after normalisation --
 * `SlaveTemplate.name` is `@unique` (`schema.prisma:338`) and `importCatalog` skips a colliding row
 * `name_taken`, so two byte-equal names cannot both exist. `Backend Architect` against
 * `backend  architect` is precisely the case this arm is for.
 *
 * SYMMETRIC in its two arguments, so the verdict does not depend on which row `orderedPair` put
 * first: every comparison below is an equality or a `jaccard`, and both are.
 */
export function classifyPair(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateVerdict | null {
  if (a.contentSha256 !== null && a.contentSha256 === b.contentSha256) {
    return { class: 'exact', basis: 'content_hash', score: 1 }
  }
  if (normalisePersona(a.name) === normalisePersona(b.name)) {
    return { class: 'exact', basis: 'name', score: roundScore(jaccard(a.shingles, b.shingles)) }
  }
  const body = jaccard(a.shingles, b.shingles)
  if (body >= NEAR_DUPLICATE_JACCARD) {
    return { class: 'near', basis: 'body_shingles', score: roundScore(body) }
  }
  const capabilities = jaccard(new Set(a.capabilityKeys), new Set(b.capabilityKeys))
  if (capabilities >= CAPABILITY_OVERLAP_JACCARD) {
    return { class: 'overlapping', basis: 'capability_keys', score: roundScore(capabilities) }
  }
  return null
}

/** How many undismissed pairs of each class an import noticed (R7). Rides inside the existing
 *  `CatalogImport.report` Json column -- the table gains no counter column, for M42 R5's reason:
 *  the row IS the record, and `RowOutcome[]` already lives in that column. */
export type DuplicateCounts = Readonly<Record<DuplicateClass, number>>

export function emptyDuplicateCounts(): DuplicateCounts {
  return { exact: 0, near: 0, overlapping: 0 }
}

/** `.strict()`, and every count a non-negative INTEGER: this is a row count read back out of a
 *  `Json` column a person can edit with `psql`, and a reader that trusted it would print `3.5
 *  exact` on an import panel. */
export const duplicateCountsSchema: z.ZodType<DuplicateCounts, z.ZodTypeDef, unknown> = z
  .object({
    exact: z.number().int().nonnegative(),
    near: z.number().int().nonnegative(),
    overlapping: z.number().int().nonnegative(),
  })
  .strict()

/** The counts a stored report holds, or three zeroes when it holds something else -- every
 *  `CatalogImport` row written before this milestone, and any row a hand edit broke. Zeroes rather
 *  than `null` so `list-imports` prints seven numbers for every row it has ever written (erratum
 *  E9), and an old import reads as "nothing was noticed", which is true: nothing was looking. */
export function parseDuplicateCounts(value: unknown): DuplicateCounts {
  const parsed = duplicateCountsSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyDuplicateCounts()
}
