import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { catalogSearchText, contentHashOf, emptyProfileSpec, type ProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_PAGE_SIZE, listWorkforceCatalog } from '../../src/catalog.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

const specOf = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'Somebody who does a thing',
  summary: 'Does the thing and says so',
  capabilities: ['Deployment'],
  expertise: ['Reading a dashboard'],
  recommendedSkills: ['writing-plans'],
  ...over,
})

interface RowInput {
  readonly name: string
  readonly description?: string
  readonly division?: string | null
  readonly sourceId?: string | null
  readonly active?: boolean
  readonly capabilityKeys?: readonly string[]
  readonly skills?: readonly string[]
  readonly spec?: ProfileSpec | null
}

const write = async (input: RowInput): Promise<string> => {
  const spec = input.spec === undefined ? specOf() : input.spec
  const description = input.description ?? `${input.name} does one thing.`
  const row = await prisma.slaveTemplate.create({
    data: {
      name: input.name,
      role: 'backend',
      description,
      sourceId: input.sourceId === undefined ? `catalog-m55/${input.name.toLowerCase().replace(/ /gu, '-')}` : input.sourceId,
      sourceDivision: input.division === undefined ? 'engineering' : input.division,
      active: input.active ?? false,
      capabilityKeys: [...(input.capabilityKeys ?? ['backend.services'])],
      recommendedSkills: [...(input.skills ?? spec?.recommendedSkills ?? [])],
      searchText: catalogSearchText({ name: input.name, description, spec }),
      contentSha256: spec === null ? null : contentHashOf(spec),
      ...(spec === null ? {} : { profileSpec: spec as unknown as Prisma.InputJsonValue }),
    },
  })
  return row.id
}

/** An undismissed pair, written straight through Prisma -- `writeTemplateDuplicates` is Task 3's. */
const pair = async (
  aId: string,
  bId: string,
  klass: 'exact' | 'near' | 'overlapping',
  score: number,
): Promise<string> => {
  const [low, high] = aId < bId ? [aId, bId] : [bId, aId]
  const row = await prisma.templateDuplicate.create({
    data: { aId: low, bId: high, class: klass, basis: klass === 'exact' ? 'content_hash' : 'body_shingles', score },
  })
  return row.id
}

describe('listWorkforceCatalog: the page (M55 R3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('spells the page size once', () => {
    expect(CATALOG_PAGE_SIZE).toBe(100)
  })

  it('returns at most a page, the total over the same filter, and a cursor to the rest', async (): Promise<void> => {
    for (let index = 0; index < 7; index += 1) await write({ name: `Row ${String(index).padStart(2, '0')}` })

    const first = await listWorkforceCatalog({}, { pageSize: 3 })

    expect(first.rows.map((row) => row.name)).toEqual(['Row 00', 'Row 01', 'Row 02'])
    expect(first.total).toBe(7)
    expect(first.nextCursor).toBe(first.rows[2]?.id)
  })

  it('walks the whole catalog through the cursor, with no row twice and none missed', async (): Promise<void> => {
    for (let index = 0; index < 7; index += 1) await write({ name: `Row ${String(index).padStart(2, '0')}` })

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const answer: Awaited<ReturnType<typeof listWorkforceCatalog>> = await listWorkforceCatalog(
        {},
        { pageSize: 3, ...(cursor === null ? {} : { cursor }) },
      )
      seen.push(...answer.rows.map((row) => row.name))
      cursor = answer.nextCursor
      if (cursor === null) break
    }

    expect(seen).toEqual(['Row 00', 'Row 01', 'Row 02', 'Row 03', 'Row 04', 'Row 05', 'Row 06'])
    expect(new Set(seen).size).toBe(7)
    expect(cursor).toBeNull()
  })

  it('answers a null cursor when the page IS the whole answer', async (): Promise<void> => {
    await write({ name: 'Only Row' })

    const page = await listWorkforceCatalog({}, { pageSize: 3 })

    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(1)
    expect(page.nextCursor).toBeNull()
  })
})

describe('listWorkforceCatalog: the seven filters, in the database (M55 R3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('filters by division', async (): Promise<void> => {
    await write({ name: 'Engineer', division: 'engineering' })
    await write({ name: 'Tester', division: 'testing' })

    expect((await listWorkforceCatalog({ division: 'testing' })).rows.map((row) => row.name)).toEqual(['Tester'])
  })

  it('filters by source, both ways', async (): Promise<void> => {
    await write({ name: 'Imported One' })
    await write({ name: 'Hand Made', sourceId: null, division: null })

    expect((await listWorkforceCatalog({ source: 'imported' })).rows.map((row) => row.name)).toEqual(['Imported One'])
    expect((await listWorkforceCatalog({ source: 'local' })).rows.map((row) => row.name)).toEqual(['Hand Made'])
  })

  it('filters by capability KEY -- the vocabulary M47 resolved, not the free text', async (): Promise<void> => {
    await write({ name: 'Backender', capabilityKeys: ['backend.services', 'backend.api-design'] })
    await write({ name: 'Securer', capabilityKeys: ['security.application'] })

    expect((await listWorkforceCatalog({ capability: 'backend.api-design' })).rows.map((row) => row.name)).toEqual(['Backender'])
  })

  it('filters by skill, off the denormalised column', async (): Promise<void> => {
    await write({ name: 'Planner', skills: ['writing-plans'] })
    await write({ name: 'Debugger', skills: ['systematic-debugging'] })

    expect((await listWorkforceCatalog({ skill: 'systematic-debugging' })).rows.map((row) => row.name)).toEqual(['Debugger'])
  })

  it('filters by activation, both ways', async (): Promise<void> => {
    await write({ name: 'Live One', active: true })
    await write({ name: 'Inert One', active: false })

    expect((await listWorkforceCatalog({ active: true })).rows.map((row) => row.name)).toEqual(['Live One'])
    expect((await listWorkforceCatalog({ active: false })).rows.map((row) => row.name)).toEqual(['Inert One'])
  })

  // The case R3's own `*(verified: ...)* ` note is about: `gate:m46-workforce-catalog` stage 2a
  // searches for a word that is in the persona's SUMMARY and in neither its name nor its blurb.
  it('searches the SUMMARY, not only the name -- which is what `searchText` exists for', async (): Promise<void> => {
    await write({
      name: 'Gate Release Steward',
      description: 'Gets a change out and watches what it does.',
      spec: specOf({ summary: 'Takes one rollout to production at a time' }),
    })
    await write({ name: 'Somebody Else', description: 'Unrelated.', spec: specOf({ summary: 'Nothing like it' }) })

    expect((await listWorkforceCatalog({ q: 'rollout' })).rows.map((row) => row.name)).toEqual(['Gate Release Steward'])
  })

  it('searches case-insensitively and through collapsed whitespace, because both sides fold the same way', async (): Promise<void> => {
    await write({ name: 'Gate Release Steward', spec: specOf({ summary: 'Takes one ROLLOUT   to production' }) })

    // The stored column is folded by `normalisePersona` and so is the query, so a phrase typed with
    // its own case and its own spacing lands on the same string either way round.
    expect((await listWorkforceCatalog({ q: '  ROLLOUT   to production ' })).rows).toHaveLength(1)
    expect((await listWorkforceCatalog({ q: '  Rollout To ' })).rows).toHaveLength(1)
    // And folding is not matching: a phrase the folded text does not hold still matches nothing.
    expect((await listWorkforceCatalog({ q: 'rollout back' })).rows).toHaveLength(0)
  })

  it('filters by duplicate CLASS, over both sides of the pair', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const c = await write({ name: 'Gamma' })
    const d = await write({ name: 'Delta' })
    await pair(a, b, 'exact', 1)
    await pair(c, d, 'overlapping', 0.667)

    expect((await listWorkforceCatalog({ duplicates: 'exact' })).rows.map((row) => row.name)).toEqual(['Alpha', 'Beta'])
    expect((await listWorkforceCatalog({ duplicates: 'overlapping' })).rows.map((row) => row.name)).toEqual(['Delta', 'Gamma'])
    expect((await listWorkforceCatalog({ duplicates: 'near' })).rows).toEqual([])
  })

  it('`none` is the NOT of "any undismissed pair", and a DISMISSED pair puts a row back into it', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    await write({ name: 'Lonely' })
    const pairId = await pair(a, b, 'exact', 1)

    expect((await listWorkforceCatalog({ duplicates: 'none' })).rows.map((row) => row.name)).toEqual(['Lonely'])

    await prisma.templateDuplicate.update({ where: { id: pairId }, data: { dismissedAt: new Date(), dismissedBy: 'operator' } })

    expect((await listWorkforceCatalog({ duplicates: 'none' })).rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Lonely'])
    expect((await listWorkforceCatalog({ duplicates: 'exact' })).rows).toEqual([])
  })

  it('composes: two filters narrow together, and `total` counts the SAME where', async (): Promise<void> => {
    await write({ name: 'Live Engineer', division: 'engineering', active: true })
    await write({ name: 'Inert Engineer', division: 'engineering', active: false })
    await write({ name: 'Live Tester', division: 'testing', active: true })

    const page = await listWorkforceCatalog({ division: 'engineering', active: true })

    expect(page.rows.map((row) => row.name)).toEqual(['Live Engineer'])
    expect(page.total).toBe(1)
  })
})

describe('listWorkforceCatalog: the facets and the row (M55 R3, R6)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('computes every facet over the WHOLE table, never over the page (M46 R6, unchanged)', async (): Promise<void> => {
    await write({ name: 'Engineer', division: 'engineering', capabilityKeys: ['backend.services'], skills: ['writing-plans'] })
    await write({ name: 'Tester', division: 'testing', capabilityKeys: ['qa.test-strategy'], skills: ['systematic-debugging'] })

    const page = await listWorkforceCatalog({ division: 'engineering' })

    expect(page.rows).toHaveLength(1)
    expect(page.facets.divisions).toEqual(['engineering', 'testing'])
    expect(page.facets.capabilities).toEqual(['backend.services', 'qa.test-strategy'])
    expect(page.facets.skills).toEqual(['systematic-debugging', 'writing-plans'])
  })

  it('offers taxonomy KEYS as the capability facet, which is what a `has` clause can match', async (): Promise<void> => {
    await write({ name: 'Engineer', capabilityKeys: ['backend.api-design'] })

    expect((await listWorkforceCatalog()).facets.capabilities).toEqual(['backend.api-design'])
  })

  it('leaves a null division out of the facet rather than printing an empty option', async (): Promise<void> => {
    await write({ name: 'Hand Made', sourceId: null, division: null })

    expect((await listWorkforceCatalog()).facets.divisions).toEqual([])
  })

  it('carries activation on every row, with its stamp', async (): Promise<void> => {
    const id = await write({ name: 'Live One', active: true })
    await prisma.slaveTemplate.update({
      where: { id },
      data: { activationChangedAt: new Date('2026-09-14T09:00:00.000Z'), activationChangedBy: 'operator' },
    })

    const row = (await listWorkforceCatalog()).rows[0]
    expect(row?.active).toBe(true)
    expect(row?.activationChangedBy).toBe('operator')
    expect(row?.activationChangedAt?.toISOString()).toBe('2026-09-14T09:00:00.000Z')
  })

  it('carries the HIGHEST-class undismissed pair and a count, so the chip can say `+N`', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const c = await write({ name: 'Gamma' })
    await pair(a, b, 'overlapping', 0.667)
    await pair(a, c, 'exact', 1)

    const alpha = (await listWorkforceCatalog()).rows.find((row) => row.name === 'Alpha')
    expect(alpha?.duplicate?.class).toBe('exact')
    expect(alpha?.duplicate?.otherName).toBe('Gamma')
    expect(alpha?.duplicate?.score).toBe(1)
    expect(alpha?.duplicateCount).toBe(2)
  })

  it('carries NOTHING for a row whose only pair is dismissed', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const pairId = await pair(a, b, 'exact', 1)
    await prisma.templateDuplicate.update({ where: { id: pairId }, data: { dismissedAt: new Date(), dismissedBy: 'operator' } })

    const alpha = (await listWorkforceCatalog()).rows.find((row) => row.name === 'Alpha')
    expect(alpha?.duplicate).toBeNull()
    expect(alpha?.duplicateCount).toBe(0)
  })

  it('names the OTHER template whichever side of the pair this row is', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    await pair(a, b, 'near', 0.9)

    const rows = await listWorkforceCatalog()
    expect(rows.rows.find((row) => row.name === 'Alpha')?.duplicate?.otherName).toBe('Beta')
    expect(rows.rows.find((row) => row.name === 'Beta')?.duplicate?.otherName).toBe('Alpha')
  })

  it('keeps every field M46 and M47 put on a row', async (): Promise<void> => {
    await write({ name: 'Full Row', capabilityKeys: ['backend.services'] })

    const row = (await listWorkforceCatalog()).rows[0]
    expect(row?.source).toBe('imported')
    expect(row?.structured).toBe(true)
    expect(row?.summary).toBe('Does the thing and says so')
    expect(row?.capabilities).toEqual(['Deployment'])
    expect(row?.capabilityKeys).toEqual(['backend.services'])
    expect(row?.expertise).toEqual(['Reading a dashboard'])
    expect(row?.recommendedSkills).toEqual(['writing-plans'])
    expect(row?.rawOverride).toBe(false)
    expect(row?.catalogSlaveCount).toBe(0)
  })
})
