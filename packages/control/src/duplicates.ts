import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  canonicalPersonaText,
  classifyPair,
  emptyDuplicateCounts,
  err,
  normalisePersona,
  ok,
  orderedPair,
  profileOverridesSchema,
  profileSpecSchema,
  shinglesOf,
  type DuplicateBasis,
  type DuplicateCandidate,
  type DuplicateClass,
  type DuplicateCounts,
  type Result,
} from '@slave-of-ai/domain'
import { derivedColumnsOf } from './catalog.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Which catalog rows look like which other catalog rows (M55 R4, R5).
 *
 * **Every loop in this file is bounded, and the bound is STATED rather than hoped for.** The scan
 * reads a projection for at most {@link DUPLICATE_SCAN_MAX} rows; each row takes at most
 * {@link DUPLICATE_CANDIDATES_MAX} partners; and the `profileSpec` column -- the only large column
 * this pass touches at all -- is read in batches of at most {@link DUPLICATE_SPECS_MAX} rows and
 * dropped between them.
 *
 * **The signal never deletes a template.** `deleteSlaveTemplate` (`./org.ts`) is still the only verb
 * in this product that removes a catalog row, and it is a person's act through a confirm. What this
 * file may remove is a PAIR, and only in {@link recomputeTemplateDuplicates}: the table is derived
 * state, and a pair that no longer classifies is not a signal somebody dismissed, it is a fact that
 * stopped being true. The residual is stated rather than hidden -- a pair that stops classifying and
 * later classifies again comes back UNDISMISSED (section 6, item 3).
 *
 * **No event.** The catalog has no workspace (M42 R5); `detectedAt`, `dismissedAt` and `dismissedBy`
 * on the row are the record.
 */

/** How many rows one pass will pair at all, id ascending. A projection of five columns over five
 *  thousand rows is about five megabytes, held once. A catalog beyond it is paired against its first
 *  five thousand rows and `truncated` says so, which is a report and not a fix (section 6, item 7). */
export const DUPLICATE_SCAN_MAX = 5000

/**
 * How many partners one row takes, id ascending within each candidate source.
 *
 * It bites only where a catalog holds hundreds of near-identical personas -- which is itself the
 * signal -- and what is lost there is the 201st instance of a duplicate the operator has already
 * been told about (section 6, item 8).
 *
 * The cap is filled STRONGEST SOURCE FIRST (plan decision D34): the content-hash bucket, then the
 * name bucket, then the band buckets, then the capability buckets, each id ascending. Every source
 * is deterministic and the order between them is fixed, so the choice is reproducible -- and a row
 * sitting in a two-thousand-member `backend.services` bucket cannot crowd out the one other row that
 * holds its exact persona text.
 */
export const DUPLICATE_CANDIDATES_MAX = 200

/** How many `profileSpec` columns are held in memory at once. The pairs are processed in id order
 *  and the shingle map is rebuilt per batch, so peak memory is this many personas' shingles -- about
 *  forty megabytes at a thousand rows of ordinary persona length -- rather than the whole catalog's.
 *  A partner that spans two batches is read twice, which is a re-read and not unbounded memory. */
export const DUPLICATE_SPECS_MAX = 1000

/** How many pairs one read of the table hands back (`listEvidence`'s own shape). */
export const TEMPLATE_DUPLICATES_LIMIT = 200

/** What a pass did. `counts` is what an import reports and what `list-imports` prints. */
export interface DuplicateScanResult {
  readonly counts: DuplicateCounts
  /** The scan hit {@link DUPLICATE_SCAN_MAX}: there are rows this pass did not pair. */
  readonly truncated: boolean
  readonly created: number
  readonly updated: number
  /** Always 0 for {@link writeTemplateDuplicates}: an import never retires a pair. */
  readonly removed: number
}

/** The five columns a pass reads per row. NOT `profileSpec`, which is read separately and in
 *  batches -- this projection is what makes "five megabytes held once" true. */
interface ScanRow {
  readonly id: string
  readonly name: string
  readonly contentSha256: string | null
  readonly capabilityKeys: string[]
  readonly bodyBands: string[]
}

interface PairKey {
  readonly aId: string
  readonly bId: string
}

const keyOf = (pair: PairKey): string => `${pair.aId}|${pair.bId}`

/** An inverted index: bucket value -> the ids in it, id ascending because the rows arrive that way. */
function invert(rows: readonly ScanRow[], valuesOf: (row: ScanRow) => readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const row of rows) {
    for (const value of valuesOf(row)) {
      const bucket = index.get(value)
      if (bucket === undefined) index.set(value, [row.id])
      else bucket.push(row.id)
    }
  }
  return index
}

/**
 * Every pair worth computing an exact Jaccard for, from four inverted indexes (M55 R4).
 *
 * Banding answers the `near` class and nothing else: two rows share a band key with probability
 * 1 - (1 - j^6)^16, which is 0.992 at the 0.8 threshold and 0.012 at a Jaccard of 0.3 -- sixty
 * candidates a row on a five-thousand-row catalog rather than six hundred. The other three classes
 * need their own candidates, because a pair can be `exact` with no shingle in common (two rows with
 * the same NAME and different bodies) and `overlapping` with no shingle in common by definition.
 *
 * `focus` is the import's own set: a pass triggered by an import pairs the rows it TOUCHED against
 * the whole catalog and never re-pairs two rows it did not touch. `null` is the recompute, which
 * pairs everything.
 */
function candidatePairs(rows: readonly ScanRow[], focus: ReadonlySet<string> | null): readonly PairKey[] {
  const byHash = invert(rows, (row) => (row.contentSha256 === null ? [] : [row.contentSha256]))
  const byName = invert(rows, (row) => [normalisePersona(row.name)])
  const byBand = invert(rows, (row) => row.bodyBands)
  const byCapability = invert(rows, (row) => row.capabilityKeys)

  const pairs = new Map<string, PairKey>()
  for (const row of rows) {
    // The strongest sources first, so a crowded capability bucket cannot crowd out the one other row
    // holding this row's exact persona text.
    const sources: readonly (readonly string[])[] = [
      row.contentSha256 === null ? [] : (byHash.get(row.contentSha256) ?? []),
      byName.get(normalisePersona(row.name)) ?? [],
      row.bodyBands.flatMap((band) => byBand.get(band) ?? []),
      row.capabilityKeys.flatMap((key) => byCapability.get(key) ?? []),
    ]
    const taken = new Set<string>()
    for (const source of sources) {
      if (taken.size >= DUPLICATE_CANDIDATES_MAX) break
      for (const other of source) {
        if (taken.size >= DUPLICATE_CANDIDATES_MAX) break
        if (other === row.id || taken.has(other)) continue
        // Skipped when neither end is in focus: an import pairs the rows it touched against the
        // whole catalog, and never re-pairs two rows it did not touch. BEFORE `taken.add` (final
        // wave, minor 4): a partner this pass discards is not a partner this row TOOK, and charging
        // it to the budget let a focused import spend a row's two hundred slots on pairs it then
        // threw away -- so the two-hundred-and-first partner, the one actually in focus, was never
        // reached.
        if (focus !== null && !focus.has(row.id) && !focus.has(other)) continue
        taken.add(other)
        const [aId, bId] = orderedPair(row.id, other)
        pairs.set(`${aId}|${bId}`, { aId, bId })
      }
    }
  }
  // Sorted, so the batching below walks the pairs in one stable order and two runs read the same
  // specs in the same batches.
  return [...pairs.values()].sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0))
}

/** The shingle set of every named row, from one `findMany` over at most `DUPLICATE_SPECS_MAX` ids.
 *  A row whose `profileSpec` does not parse -- hand-edited, or written by a future version -- gets
 *  an EMPTY set, which is `jaccard`'s zero and never a crash on a catalog page. */
async function shinglesFor(ids: readonly string[]): Promise<Map<string, ReadonlySet<string>>> {
  const rows = await prisma.slaveTemplate.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, profileSpec: true },
  })
  const out = new Map<string, ReadonlySet<string>>()
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    out.set(row.id, spec.success ? shinglesOf(canonicalPersonaText(spec.data)) : new Set<string>())
  }
  return out
}

interface ClassifiedPair extends PairKey {
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
}

const candidateOf = (row: ScanRow, shingles: ReadonlyMap<string, ReadonlySet<string>>): DuplicateCandidate => ({
  id: row.id,
  name: row.name,
  contentSha256: row.contentSha256,
  capabilityKeys: row.capabilityKeys,
  shingles: shingles.get(row.id) ?? new Set<string>(),
})

/** One pass: read the projection, form the candidates, classify them in batches. Writes nothing. */
async function classifyAll(focus: ReadonlySet<string> | null): Promise<{
  readonly classified: readonly ClassifiedPair[]
  readonly scanned: ReadonlySet<string>
  readonly truncated: boolean
}> {
  const rows: ScanRow[] = await prisma.slaveTemplate.findMany({
    select: { id: true, name: true, contentSha256: true, capabilityKeys: true, bodyBands: true },
    orderBy: { id: 'asc' },
    take: DUPLICATE_SCAN_MAX,
  })
  const byId = new Map(rows.map((row) => [row.id, row] as const))
  const pairs = candidatePairs(rows, focus)

  const classified: ClassifiedPair[] = []
  let index = 0
  while (index < pairs.length) {
    const batch: PairKey[] = []
    const needed = new Set<string>()
    // A single pair always fits (two ids against a thousand), so this loop always advances.
    while (index < pairs.length && needed.size + 2 <= DUPLICATE_SPECS_MAX) {
      const pair = pairs[index] as PairKey
      batch.push(pair)
      needed.add(pair.aId)
      needed.add(pair.bId)
      index += 1
    }
    const shingles = await shinglesFor([...needed])
    for (const pair of batch) {
      const a = byId.get(pair.aId)
      const b = byId.get(pair.bId)
      if (a === undefined || b === undefined) continue
      const verdict = classifyPair(candidateOf(a, shingles), candidateOf(b, shingles))
      if (verdict === null) continue
      classified.push({ ...pair, class: verdict.class, basis: verdict.basis, score: verdict.score })
    }
  }

  return { classified, scanned: new Set(rows.map((row) => row.id)), truncated: rows.length === DUPLICATE_SCAN_MAX }
}

/**
 * What one pair's write did.
 *
 * TWO facts, not one, and they are independent (fix round 1, item 2): `wrote` is what happened to
 * the row, and `dismissed` is whether the operator has already said they know about this pair. A
 * dismissed pair whose verdict CHANGED is a row that moved -- it belongs in `updated`, because
 * `updated` is what the pass did -- and is still not tallied into `counts`, because the counts are
 * what the operator is being TOLD. Collapsing the two into one verdict is how `updated`
 * under-reported.
 */
interface PairWrite {
  /** `null` when the stored verdict already matched and nothing at all was written. */
  readonly wrote: 'created' | 'updated' | null
  readonly dismissed: boolean
}

/** Writes one classified pair, and says what it did. Read-then-write rather than `upsert`, for two
 *  reasons: a pair whose verdict has not changed is not written AT ALL (so `detectedAt` cannot move
 *  and a re-import genuinely writes nothing), and the caller can report `created` against `updated`.
 *  The unique index is still the authority -- a concurrent create answers P2002 and is turned into
 *  the update it should have been. */
async function writePair(pair: ClassifiedPair): Promise<PairWrite> {
  const existing = await prisma.templateDuplicate.findUnique({
    where: { aId_bId: { aId: pair.aId, bId: pair.bId } },
    select: { id: true, class: true, basis: true, score: true, dismissedAt: true },
  })
  if (existing === null) {
    try {
      await prisma.templateDuplicate.create({
        data: { aId: pair.aId, bId: pair.bId, class: pair.class, basis: pair.basis, score: pair.score },
      })
      return { wrote: 'created', dismissed: false }
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error
      await prisma.templateDuplicate.update({
        where: { aId_bId: { aId: pair.aId, bId: pair.bId } },
        data: { class: pair.class, basis: pair.basis, score: pair.score },
      })
      // A row created between this pass's read and its write is a row nobody has seen yet, so
      // nobody has dismissed it.
      return { wrote: 'updated', dismissed: false }
    }
  }
  const same = existing.class === pair.class && existing.basis === pair.basis && existing.score === pair.score
  if (!same) {
    // `detectedAt` is NOT in this write and never will be: it is when this pair was first noticed,
    // and a re-classification is not a new noticing. Neither is the dismissal.
    await prisma.templateDuplicate.update({
      where: { id: existing.id },
      data: { class: pair.class, basis: pair.basis, score: pair.score },
    })
  }
  return { wrote: same ? null : 'updated', dismissed: existing.dismissedAt !== null }
}

/** What a batch of classified pairs added up to, once every one of them has been written. */
interface WriteTally {
  readonly counts: DuplicateCounts
  readonly created: number
  readonly updated: number
}

/**
 * The write-and-tally loop, spelled ONCE (Task 3 scan ruling).
 *
 * Both passes -- the import's and the recompute's -- write the same pairs the same way and count
 * them the same way, and the only difference between them is what they do AFTERWARDS about pairs
 * that are no longer here. Two copies of this loop is how a dismissal starts being counted by one of
 * them and not the other.
 *
 * A DISMISSED pair is re-confirmed in place and not COUNTED: the counts are what the operator is
 * being told about, and a dismissal is them saying they already know.
 */
async function writeAndTally(classified: readonly ClassifiedPair[]): Promise<WriteTally> {
  const counts: Record<DuplicateClass, number> = { exact: 0, near: 0, overlapping: 0 }
  let created = 0
  let updated = 0
  for (const pair of classified) {
    const outcome = await writePair(pair)
    if (outcome.wrote === 'created') created += 1
    if (outcome.wrote === 'updated') updated += 1
    if (!outcome.dismissed) counts[pair.class] += 1
  }
  return { counts, created, updated }
}

/**
 * The importer's FOURTH post-pass (M55 R7), beside `writeCollaborationHints` and
 * `writePersonaRunbooks` and for their exact reason (M42 plan erratum E11): a persona imported later
 * in the same run is not in the table while an earlier row is being written, so pairing before the
 * loop ends would miss every pair inside the run.
 *
 * Pairs the rows this import TOUCHED against the whole catalog, and never re-pairs two rows it did
 * not touch. **Removes nothing**: `removed` is always 0, and retiring a pair is
 * {@link recomputeTemplateDuplicates}'s act alone. A pair a person has DISMISSED is still
 * re-confirmed in place -- its class and score are kept current -- and is not COUNTED, because the
 * counts are what the operator is being told about and a dismissal is them saying they already know.
 */
export async function writeTemplateDuplicates(templateIds: readonly string[]): Promise<DuplicateScanResult> {
  if (templateIds.length === 0) {
    return { counts: emptyDuplicateCounts(), truncated: false, created: 0, updated: 0, removed: 0 }
  }
  const { classified, truncated } = await classifyAll(new Set(templateIds))
  const tally = await writeAndTally(classified)
  return { ...tally, truncated, removed: 0 }
}

/**
 * Fills the four derived columns for every row that has a `profileSpec` and is missing one, in
 * batches of {@link DUPLICATE_SPECS_MAX}. Returns how many rows moved.
 *
 * **The walk advances by ID and never re-selects by predicate** (fix round 1, item 1). The obvious
 * loop -- ask for the next page of rows the predicate still matches -- terminates only if every
 * update CLEARS the predicate, and two kinds of row do not clear it: one whose `profileSpec` this
 * build cannot parse (left alone deliberately, below), and one whose derivation genuinely yields
 * `searchText: ''`. The second needs an empty name AND an empty description AND a spec with no
 * identity, summary or lists, which is a narrow door -- but the column cannot tell "not derived
 * yet" from "derived to nothing" (`schema.prisma`: `""` means not backfilled yet, and it is NOT
 * NULL), so no predicate could, and closing that door with a schema change is a migration for one
 * pathological row. A cursor closes it without one: each pass either returns or moves strictly
 * forward, so the walk is `O(rows)` whatever any single update does or does not change.
 *
 * `id: { gt: cursor }` rather than Prisma's `cursor`/`skip: 1`, deliberately: `skip: 1` skips the
 * first row the `where` matches at or after the cursor, and this walk EDITS the rows it reads, so
 * the cursor row itself usually stops matching -- and the skip would then eat a row nobody had
 * looked at. The stale-pair walk in {@link recomputeTemplateDuplicates} may use `cursor` because it
 * does not write what it reads.
 */
async function backfillDerivedColumns(): Promise<number> {
  let filled = 0
  let cursor: string | null = null
  for (;;) {
    // Annotated, because `cursor` is assigned FROM `rows` and read INSIDE the query that produces
    // them -- TS7022 without it (the stale-pair walk below carries one for the same reason).
    const rows: {
      id: string
      name: string
      description: string
      profileSpec: Prisma.JsonValue | null
      profileOverrides: Prisma.JsonValue | null
    }[] = await prisma.slaveTemplate.findMany({
      where: {
        ...(cursor === null ? {} : { id: { gt: cursor } }),
        NOT: { profileSpec: { equals: Prisma.DbNull } },
        OR: [{ contentSha256: null }, { bodyBands: { isEmpty: true } }, { searchText: '' }],
      },
      select: { id: true, name: true, description: true, profileSpec: true, profileOverrides: true },
      orderBy: { id: 'asc' },
      take: DUPLICATE_SPECS_MAX,
    })
    if (rows.length === 0) return filled
    for (const row of rows) {
      const spec = profileSpecSchema.safeParse(row.profileSpec)
      // A spec this build cannot parse is left alone rather than half-derived: a `contentSha256`
      // over an empty spec would be a hash of nothing, claiming a persona this row does not have.
      if (!spec.success) continue
      const stored = profileOverridesSchema.safeParse(row.profileOverrides ?? {})
      await prisma.slaveTemplate.update({
        where: { id: row.id },
        data: derivedColumnsOf({
          name: row.name,
          description: row.description,
          upstream: spec.data,
          overrides: stored.success ? stored.data : {},
        }),
      })
      filled += 1
    }
    cursor = rows[rows.length - 1]?.id ?? null
    if (cursor === null) return filled
  }
}

/**
 * The whole-table pass (M55 R4/R5), and the BACKFILL (R10).
 *
 * Two things in one verb because they are one operator act: an install upgrading to M55 has rows
 * with a `profileSpec` and none of the four derived columns, and pairing them before filling those
 * columns would classify every one of them as having no persona text at all. The backfill runs
 * FIRST, in batches of {@link DUPLICATE_SPECS_MAX}, and only touches rows that have a spec and are
 * missing at least one column.
 *
 * It deliberately does NOT recompute `capabilityKeys` (R10): that is the importer's write, against a
 * taxonomy the import also syncs, and a second writer for one column is how two writers disagree.
 *
 * Then it re-classifies the whole table, updates `class`/`basis`/`score` in place -- keeping
 * `detectedAt` and any dismissal -- and REMOVES a pair that no longer classifies at all, as long as
 * both of its rows were inside this scan. A pair whose rows fell outside `DUPLICATE_SCAN_MAX` is
 * left exactly where it is, because this pass has no opinion about a pair it did not look at.
 */
export async function recomputeTemplateDuplicates(): Promise<DuplicateScanResult & { readonly backfilled: number }> {
  const backfilled = await backfillDerivedColumns()
  const { classified, scanned, truncated } = await classifyAll(null)

  const tally = await writeAndTally(classified)

  const survivors = new Set(classified.map(keyOf))
  const stale: string[] = []
  let cursor: string | null = null
  for (;;) {
    const page: { id: string; aId: string; bId: string }[] = await prisma.templateDuplicate.findMany({
      select: { id: true, aId: true, bId: true },
      orderBy: { id: 'asc' },
      take: DUPLICATE_SPECS_MAX,
      ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    })
    if (page.length === 0) break
    for (const row of page) {
      if (!scanned.has(row.aId) || !scanned.has(row.bId)) continue
      if (survivors.has(keyOf(row))) continue
      stale.push(row.id)
    }
    if (page.length < DUPLICATE_SPECS_MAX) break
    cursor = page[page.length - 1]?.id ?? null
  }
  for (let index = 0; index < stale.length; index += DUPLICATE_SPECS_MAX) {
    await prisma.templateDuplicate.deleteMany({ where: { id: { in: stale.slice(index, index + DUPLICATE_SPECS_MAX) } } })
  }

  return { ...tally, truncated, removed: stale.length, backfilled }
}

/** One pair as the CLI and the drawer read it: both names, so a surface never joins to print a
 *  sentence (`docs/ia.md` rule 3 -- an id says nothing to the person reading it). */
export interface TemplateDuplicateView {
  readonly id: string
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
  readonly detectedAt: Date
  readonly dismissedAt: Date | null
  readonly dismissedBy: string | null
  readonly aId: string
  readonly aName: string
  readonly bId: string
  readonly bName: string
}

/** What one read of the pair table hands back: the page, and how many pairs the same filter matches
 *  (final wave, Important 2). `listWorkforceCatalog`'s own shape, for its own reason -- a list cut
 *  at {@link TEMPLATE_DUPLICATES_LIMIT} and printed without its total looks complete and is not. */
export interface TemplateDuplicatePage {
  readonly rows: readonly TemplateDuplicateView[]
  readonly total: number
}

/**
 * The pairs, strongest first (M55 R6/R10).
 *
 * `orderBy: { class: 'asc' }` IS the class ranking: a Postgres enum compares in DECLARATION order,
 * and `DuplicateClass` is declared `exact, near, overlapping` -- strongest first, which is the order
 * `classifyPair`'s arms are in. Ties break on score descending and then on id, so the list is total.
 *
 * Dismissed pairs are OUT by default and available on request: a dismissal is a person saying "I
 * know", not a person saying "delete this", and the row stays in the table forever with a Restore
 * beside it.
 *
 * `total` comes from a `count` over the SAME `where` (final wave, Important 2): the rows stop at
 * {@link TEMPLATE_DUPLICATES_LIMIT} and an operator with more pairs than that was reading a list
 * that looked like the whole answer. `template list` says `N of M` for exactly this reason, and
 * this is its sibling verb.
 */
export async function listTemplateDuplicates(
  options: {
    readonly templateId?: string
    readonly class?: DuplicateClass
    readonly includeDismissed?: boolean
    readonly limit?: number
  } = {},
): Promise<TemplateDuplicatePage> {
  const where: Prisma.TemplateDuplicateWhereInput = {
    ...(options.includeDismissed === true ? {} : { dismissedAt: null }),
    ...(options.class === undefined ? {} : { class: options.class }),
    ...(options.templateId === undefined ? {} : { OR: [{ aId: options.templateId }, { bId: options.templateId }] }),
  }
  const [rows, total] = await Promise.all([
    prisma.templateDuplicate.findMany({
      where,
      orderBy: [{ class: 'asc' }, { score: 'desc' }, { id: 'asc' }],
      take: Math.max(0, Math.min(options.limit ?? TEMPLATE_DUPLICATES_LIMIT, TEMPLATE_DUPLICATES_LIMIT)),
      select: {
        id: true,
        class: true,
        basis: true,
        score: true,
        detectedAt: true,
        dismissedAt: true,
        dismissedBy: true,
        aId: true,
        bId: true,
        a: { select: { name: true } },
        b: { select: { name: true } },
      },
    }),
    prisma.templateDuplicate.count({ where }),
  ])
  return {
    rows: rows.map((row) => ({
      id: row.id,
      class: row.class,
      basis: row.basis,
      score: row.score,
      detectedAt: row.detectedAt,
      dismissedAt: row.dismissedAt,
      dismissedBy: row.dismissedBy,
      aId: row.aId,
      aName: row.a.name,
      bId: row.bId,
      bName: row.b.name,
    })),
    total,
  }
}

/**
 * A person says "I know" about a pair, or takes it back (M55 R5).
 *
 * The ONLY writer of `dismissedAt`/`dismissedBy`. The importer never dismisses and never deletes; a
 * dismissed pair stays in the table forever, greyed rather than gone.
 *
 * Locked check-then-update, the catalog's own discipline, with every refusal reached BEFORE the
 * write so each is returned rather than thrown (ADR 0003). A restore clears BOTH halves of the
 * stamp: a `dismissedBy` with no `dismissedAt` is half a fact, and the next reader would have to
 * guess which half to believe.
 */
export async function setTemplateDuplicateDismissal(
  pairId: string,
  dismissed: boolean,
  by?: string,
): Promise<Result<{ readonly changed: boolean }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TemplateDuplicate" WHERE id = ${pairId} FOR UPDATE`
    const row = await tx.templateDuplicate.findUnique({ where: { id: pairId }, select: { id: true, dismissedAt: true } })
    if (row === null) {
      return { ok: false as const, error: { kind: 'template_duplicate_not_found', pairId } as ControlRefusal }
    }
    if ((row.dismissedAt !== null) === dismissed) return { ok: true as const, value: { changed: false } }
    await tx.templateDuplicate.update({
      where: { id: pairId },
      data: dismissed ? { dismissedAt: new Date(), dismissedBy: by ?? null } : { dismissedAt: null, dismissedBy: null },
    })
    return { ok: true as const, value: { changed: true } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}
