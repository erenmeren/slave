import { prisma } from '@slave-of-ai/db/client'
import {
  bodyBandsOf,
  catalogSearchText,
  contentHashOf,
  emptyProfileSpec,
  type ProfileSpec,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DUPLICATE_CANDIDATES_MAX,
  DUPLICATE_SCAN_MAX,
  DUPLICATE_SPECS_MAX,
  listTemplateDuplicates,
  recomputeTemplateDuplicates,
  setTemplateDuplicateDismissal,
  writeTemplateDuplicates,
} from '../../src/duplicates.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanyTeamMember", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

/** Sixty distinct words, so a body has enough shingles for a Jaccard to mean something. */
const words = (seed: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${seed}${String(index)}`).join(' ')

const specOf = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'Somebody who does a thing',
  summary: 'Does the thing',
  body: words('w', 60),
  ...over,
})

interface RowInput {
  readonly name: string
  readonly spec?: ProfileSpec | null
  readonly capabilityKeys?: readonly string[]
}

/** Counted, because `sourceId` is `@unique` and the slug below is derived from the NAME -- and two
 *  rows whose names differ only in case is exactly the fixture the `name` arm needs. */
let written = 0

/** One catalog row with its four derived columns already written -- which is what `importRow` does
 *  (Task 2) and what `recomputeTemplateDuplicates` backfills. */
const write = async (input: RowInput): Promise<string> => {
  const spec = input.spec === undefined ? specOf() : input.spec
  written += 1
  const row = await prisma.slaveTemplate.create({
    data: {
      name: input.name,
      role: 'backend',
      description: `${input.name} does one thing.`,
      sourceId: `catalog-m55/engineering/${input.name.toLowerCase().replace(/ /gu, '-')}-${String(written)}`,
      sourceDivision: 'engineering',
      capabilityKeys: [...(input.capabilityKeys ?? [])],
      ...(spec === null
        ? {}
        : {
            profileSpec: spec as unknown as object,
            contentSha256: contentHashOf(spec),
            bodyBands: [...bodyBandsOf(spec)],
            searchText: catalogSearchText({ name: input.name, description: '', spec }),
            recommendedSkills: [...spec.recommendedSkills],
          }),
    },
  })
  return row.id
}

const allPairs = async () =>
  prisma.templateDuplicate.findMany({ orderBy: [{ class: 'asc' }, { id: 'asc' }] })

describe('the three bounds (M55 R4)', () => {
  it('spells each once, where the pass reads it', () => {
    expect(DUPLICATE_SCAN_MAX).toBe(5000)
    expect(DUPLICATE_CANDIDATES_MAX).toBe(200)
    expect(DUPLICATE_SPECS_MAX).toBe(1000)
  })
})

describe('writeTemplateDuplicates: the three classes (M55 R4, R5)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('writes an EXACT pair for two rows whose persona text is identical after normalisation', async (): Promise<void> => {
    const a = await write({ name: 'Backend Architect', spec: specOf({ body: 'One   TWO three four five six seven' }) })
    const b = await write({ name: 'Server Specialist', spec: specOf({ body: 'one two   three four five six seven' }) })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('exact')
    expect(pairs[0]?.basis).toBe('content_hash')
    expect(pairs[0]?.score).toBe(1)
    expect(result.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
    expect(result.created).toBe(1)
  })

  it('writes an EXACT pair for two rows whose NAMES differ only in case', async (): Promise<void> => {
    // Identity and summary differ too, not only the body: the score on this arm is the jaccard of
    // the whole canonical text, so two personas that shared `specOf`'s default identity would share
    // the shingles across it and score a little above zero for a reason this case is not about.
    const a = await write({
      name: 'Release Steward',
      spec: specOf({ identity: words('alphaid', 8), summary: words('alphasum', 8), body: words('alpha', 60) }),
    })
    const b = await write({
      name: 'release  steward',
      spec: specOf({ identity: words('omegaid', 8), summary: words('omegasum', 8), body: words('omega', 60) }),
    })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('exact')
    expect(pairs[0]?.basis).toBe('name')
    expect(pairs[0]?.score).toBe(0)
  })

  it('writes a NEAR pair for two bodies sharing about nine tenths of their shingles', async (): Promise<void> => {
    const shared = words('w', 60)
    const a = await write({ name: 'One', spec: specOf({ body: shared }) })
    const b = await write({ name: 'Two', spec: specOf({ body: `${shared} tail one tail two tail three` }) })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('near')
    expect(pairs[0]?.basis).toBe('body_shingles')
    expect(pairs[0]?.score).toBeGreaterThanOrEqual(0.8)
    expect(pairs[0]?.score).toBeLessThan(1)
    expect(result.counts).toEqual({ exact: 0, near: 1, overlapping: 0 })
  })

  it('writes an OVERLAPPING pair for two different personas claiming four of five capabilities', async (): Promise<void> => {
    const a = await write({
      name: 'One',
      spec: specOf({ body: words('alpha', 60) }),
      capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'],
    })
    const b = await write({
      name: 'Two',
      spec: specOf({ body: words('omega', 60) }),
      capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k9'],
    })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('overlapping')
    expect(pairs[0]?.basis).toBe('capability_keys')
    expect(pairs[0]?.score).toBe(0.667)
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 1 })
  })

  it('writes NOTHING for a pair just under every threshold', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: words('alpha', 60) }), capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = await write({ name: 'Two', spec: specOf({ body: words('omega', 60) }), capabilityKeys: ['k1', 'k2', 'k7', 'k8', 'k9'] })

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual([])
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })

  it('always writes `aId < bId`, whichever order the ids were handed in', async (): Promise<void> => {
    const a = await write({ name: 'Backend Architect', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Server Specialist', spec: specOf({ body: 'same body words here now' }) })

    await writeTemplateDuplicates([b, a])

    const pairs = await allPairs()
    expect((pairs[0]?.aId ?? '') < (pairs[0]?.bId ?? '')).toBe(true)
  })

  it('writes ONE row per pair, whichever end of it the import touched', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })

    await writeTemplateDuplicates([a])
    await writeTemplateDuplicates([b])

    expect(await allPairs()).toHaveLength(1)
  })

  it('is IDEMPOTENT: a second pass over the same rows moves no id and no detectedAt', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const before = await allPairs()

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual(before)
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
  })

  it('pairs a row with NO profileSpec through the name and capability arms, and never through the text', async (): Promise<void> => {
    const a = await write({ name: 'Release Steward', spec: null, capabilityKeys: ['k1', 'k2'] })
    const b = await write({ name: 'release steward', spec: specOf(), capabilityKeys: ['k1', 'k2'] })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.basis).toBe('name')
    // Its score is the body jaccard, and a row with no spec has no shingles: nothing over nothing.
    expect(pairs[0]?.score).toBe(0)
  })

  it('never pairs a row with itself, however identical it is to itself', async (): Promise<void> => {
    const only = await write({ name: 'Alone', spec: specOf() })

    await writeTemplateDuplicates([only])

    expect(await allPairs()).toEqual([])
  })

  it('does NOT delete a pair, ever -- that is the recompute pass, and nobody else', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    // The bodies diverge under it, but the importer is not the thing that retires a pair.
    await prisma.slaveTemplate.update({ where: { id: b }, data: { contentSha256: 'something-else', bodyBands: [] } })

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toHaveLength(1)
    expect(result.removed).toBe(0)
  })
})

/**
 * One case on each side of each threshold, and one pair that satisfies two arms at once.
 *
 * `specOf`'s canonical text is identity (5 words) + summary (3) + body, so a sixty-word body is
 * sixty-eight words and sixty-four shingles; appending N distinct words to one side makes the
 * jaccard 64 / (64 + N) exactly. Both rows always share ONE capability key, so the pair is a
 * CANDIDATE whatever the bands do -- a case that asserted "nothing was written" while the two rows
 * were never compared at all would pass for the wrong reason.
 */
describe('the class boundaries (M55 R4)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  const shared = words('w', 60)

  it('takes the HIGHEST class that fits and writes only that one', async (): Promise<void> => {
    // Both arms fire: the persona text is identical (exact) and so are the capability keys (which
    // would be an overlapping jaccard of 1). One row comes out, and it is the stronger fact.
    const a = await write({ name: 'Alpha', spec: specOf(), capabilityKeys: ['c1', 'c2', 'c3'] })
    const b = await write({ name: 'Beta', spec: specOf(), capabilityKeys: ['c1', 'c2', 'c3'] })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('exact')
    expect(pairs[0]?.basis).toBe('content_hash')
    expect(result.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
  })

  it('a body jaccard of exactly 0.8 IS near -- the threshold is inclusive', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: shared }), capabilityKeys: ['c1', 'c2', 'c3'] })
    const b = await write({
      name: 'Beta',
      spec: specOf({ body: `${shared} ${words('tail', 16)}` }),
      capabilityKeys: ['c1', 'c4', 'c5'],
    })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('near')
    expect(pairs[0]?.score).toBe(0.8)
  })

  it('one shingle under it is NOT near, and falls through to a capability jaccard that is under too', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: shared }), capabilityKeys: ['c1', 'c2', 'c3'] })
    const b = await write({
      name: 'Beta',
      spec: specOf({ body: `${shared} ${words('tail', 17)}` }),
      capabilityKeys: ['c1', 'c4', 'c5'],
    })

    await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual([])
  })

  it('a capability jaccard of exactly 0.6 IS overlapping', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: words('alpha', 60) }), capabilityKeys: ['c1', 'c2', 'c3'] })
    const b = await write({
      name: 'Beta',
      spec: specOf({ body: words('omega', 60) }),
      capabilityKeys: ['c1', 'c2', 'c3', 'c4', 'c5'],
    })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('overlapping')
    expect(pairs[0]?.score).toBe(0.6)
  })

  it('one key under it is NOT overlapping, and nothing at all is written', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: words('alpha', 60) }), capabilityKeys: ['c1', 'c2', 'c3'] })
    const b = await write({
      name: 'Beta',
      spec: specOf({ body: words('omega', 60) }),
      capabilityKeys: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    })

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual([])
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })
})

describe('recomputeTemplateDuplicates (M55 R4, R5, R10)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('finds the same pairs the import pass found, and creates no tenth on a second run', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const before = await allPairs()

    const first = await recomputeTemplateDuplicates()
    const second = await recomputeTemplateDuplicates()

    expect(await allPairs()).toEqual(before)
    expect(first.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
    expect(second).toEqual(first)
  })

  it('RETIRES a pair that no longer classifies, which the importer may not do', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: words('alpha', 60) }) })
    const b = await write({ name: 'Two', spec: specOf({ body: words('omega', 60) }) })
    await prisma.templateDuplicate.create({
      data: { aId: a < b ? a : b, bId: a < b ? b : a, class: 'exact', basis: 'content_hash', score: 1 },
    })

    const result = await recomputeTemplateDuplicates()

    expect(await allPairs()).toEqual([])
    expect(result.removed).toBe(1)
  })

  it('KEEPS a dismissal through a recompute that re-confirms the pair', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const pairId = (await allPairs())[0]?.id as string
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    await recomputeTemplateDuplicates()

    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).not.toBeNull()
    expect(row.dismissedBy).toBe('operator')
  })

  it('COUNTS a dismissed pair whose verdict changed as `updated`, and still does not tally it (fix round 1, item 2)', async (): Promise<void> => {
    const a = await write({
      name: 'One',
      spec: specOf({ body: 'same body words here now' }),
      capabilityKeys: ['c1', 'c2', 'c3'],
    })
    const b = await write({
      name: 'Two',
      spec: specOf({ body: 'same body words here now' }),
      capabilityKeys: ['c1', 'c2', 'c3'],
    })
    await writeTemplateDuplicates([a, b])
    const pairId = (await allPairs())[0]?.id as string
    await setTemplateDuplicateDismissal(pairId, true, 'operator')
    // The hash moves under it, so the pair re-classifies from exact/content_hash to near/body_shingles
    // -- the same two rows, a different verdict. The shared capability keys keep it a candidate.
    await prisma.slaveTemplate.update({ where: { id: b }, data: { contentSha256: 'something-else' } })

    const result = await writeTemplateDuplicates([a, b])

    expect(result.updated).toBe(1)
    // Written, but not TOLD: the counts are what the operator is being shown, and a dismissal is
    // them having said they already know.
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 0 })
    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.class).toBe('near')
    expect(row.basis).toBe('body_shingles')
    expect(row.dismissedAt).not.toBeNull()
    expect(row.dismissedBy).toBe('operator')
  })

  it('BACKFILLS the four derived columns for a row that has a profileSpec and none of them', async (): Promise<void> => {
    const spec = specOf({ summary: 'A findable summary sentence' })
    const row = await prisma.slaveTemplate.create({
      data: {
        name: 'Pre M55 Row',
        role: 'backend',
        description: 'Imported before this milestone.',
        profileSpec: spec as unknown as object,
      },
    })

    const result = await recomputeTemplateDuplicates()

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.contentSha256).toBe(contentHashOf(spec))
    expect(after.bodyBands).toEqual([...bodyBandsOf(spec)])
    expect(after.searchText).toContain('a findable summary sentence')
    expect(after.recommendedSkills).toEqual([...spec.recommendedSkills])
    expect(result.backfilled).toBe(1)
  })

  it('does NOT recompute capabilityKeys -- a second writer for one column is how two writers disagree', async (): Promise<void> => {
    const row = await prisma.slaveTemplate.create({
      data: {
        name: 'Pre M47 Row',
        role: 'backend',
        description: 'Imported before the taxonomy existed.',
        profileSpec: specOf({ capabilities: ['Deployment'] }) as unknown as object,
        capabilityKeys: [],
      },
    })

    await recomputeTemplateDuplicates()

    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })).capabilityKeys).toEqual([])
  })

  it('TERMINATES over a row whose derived searchText is empty, and counts it (fix round 1, item 1)', async (): Promise<void> => {
    // The one row whose update cannot clear the predicate: an empty name, an empty description and a
    // spec with nothing in it derive `searchText: ''`, which is the value the `where` selects on.
    // Re-selecting by predicate would hand this row back forever; the cursor is what ends the walk.
    await prisma.slaveTemplate.create({
      data: { name: '', role: 'backend', description: '', profileSpec: emptyProfileSpec() as unknown as object },
    })

    const first = await recomputeTemplateDuplicates()
    const second = await recomputeTemplateDuplicates()

    expect(first.backfilled).toBe(1)
    // Counted again, and that is honest rather than a leak: the row IS still underived by the only
    // test the column can make, and the walk costs it one bounded update per pass.
    expect(second.backfilled).toBe(1)
  })

  it('leaves a row with NO profileSpec entirely alone -- there is nothing to derive from', async (): Promise<void> => {
    const row = await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })

    const result = await recomputeTemplateDuplicates()

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.contentSha256).toBeNull()
    expect(after.bodyBands).toEqual([])
    expect(result.backfilled).toBe(0)
  })
})

describe('setTemplateDuplicateDismissal (M55 R5)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  const onePair = async (): Promise<string> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    return (await allPairs())[0]?.id as string
  }

  it('stamps who dismissed it and when, and the row STAYS in the table', async (): Promise<void> => {
    const pairId = await onePair()

    const result = await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect(result.ok && result.value.changed).toBe(true)
    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).not.toBeNull()
    expect(row.dismissedBy).toBe('operator')
    expect(await prisma.templateDuplicate.count()).toBe(1)
  })

  it('restores it, and clears BOTH halves of the stamp rather than leaving half a fact', async (): Promise<void> => {
    const pairId = await onePair()
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    await setTemplateDuplicateDismissal(pairId, false, 'operator')

    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).toBeNull()
    expect(row.dismissedBy).toBeNull()
  })

  it('says `changed: false` for a no-op', async (): Promise<void> => {
    const pairId = await onePair()

    const result = await setTemplateDuplicateDismissal(pairId, false, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: false })
  })

  it('refuses a pair id nobody wrote, with its OWN kind (plan erratum E5)', async (): Promise<void> => {
    const result = await setTemplateDuplicateDismissal('00000000-0000-4000-8000-000000000000', true, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: 'template_duplicate_not_found',
      pairId: '00000000-0000-4000-8000-000000000000',
    })
  })

  it('writes NO event -- the catalog has no workspace', async (): Promise<void> => {
    const pairId = await onePair()
    const before = await prisma.executionEvent.count()

    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect(await prisma.executionEvent.count()).toBe(before)
  })
})

describe('listTemplateDuplicates (M55 R6, R10)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('reads a pair with BOTH names, so a surface never has to join to print a sentence', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    const { rows, total } = await listTemplateDuplicates()

    expect(rows).toHaveLength(1)
    expect(total).toBe(1)
    expect([rows[0]?.aName, rows[0]?.bName].sort()).toEqual(['Alpha', 'Beta'])
    expect(rows[0]?.class).toBe('exact')
    expect(rows[0]?.basis).toBe('content_hash')
  })

  it('scopes to one template, over BOTH sides of the pair', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await write({ name: 'Gamma', spec: specOf({ body: words('zeta', 60) }) })
    await writeTemplateDuplicates([a, b])

    expect((await listTemplateDuplicates({ templateId: a })).rows).toHaveLength(1)
    expect((await listTemplateDuplicates({ templateId: b })).rows).toHaveLength(1)
  })

  it('hides a dismissed pair by default and shows it when asked, because it is greyed rather than gone', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const pairId = (await allPairs())[0]?.id as string
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect((await listTemplateDuplicates()).rows).toEqual([])
    expect((await listTemplateDuplicates()).total).toBe(0)
    expect((await listTemplateDuplicates({ includeDismissed: true })).rows).toHaveLength(1)
  })

  it('filters by class', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    expect((await listTemplateDuplicates({ class: 'exact' })).rows).toHaveLength(1)
    expect((await listTemplateDuplicates({ class: 'near' })).rows).toEqual([])
  })

  /**
   * Final wave, Important 2. `TEMPLATE_DUPLICATES_LIMIT` is two hundred and a catalog that reaches
   * it is a catalog no test may seed, so the cap is lowered through the read's OWN seam --
   * `options.limit`, which the CLI does not pass and which clamps the same way the default does.
   * What is pinned is the property the cap makes load-bearing: `total` counts the pairs the FILTER
   * matches, not the pairs this page happens to be holding, so `N of M` can be honest.
   */
  it('counts every pair the filter matches, even when the page stops short of them', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    const c = await write({ name: 'Gamma', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b, c])

    const page = await listTemplateDuplicates({ limit: 1 })

    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(3)
    // And the total answers the SAME where: a class nothing matches counts nothing.
    expect((await listTemplateDuplicates({ class: 'near', limit: 1 })).total).toBe(0)
  })

  it('DELETING a template takes its pairs with it, and nothing else', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    await prisma.slaveTemplate.delete({ where: { id: a } })

    expect(await prisma.templateDuplicate.count()).toBe(0)
    expect(await prisma.slaveTemplate.count()).toBe(1)
  })
})
