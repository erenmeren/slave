import { prisma } from '@slave-of-ai/db/client'
import { goalSha256, importedProfilePrefix } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { importCatalog, listCatalogImports } from '../../src/catalog.js'
import { setProfile } from '../../src/profile.js'

const CATALOG = 'catalog-m42'
const DIRECTORY = '/tmp/catalog-m42'

const persona = (name: string, body = 'You build the core module and its tests.'): string =>
  `---\nname: ${name}\ndescription: ${name} does one thing well.\nvibe: One thing, well.\n---\n\n# ${name}\n\n${body}\n`

const entry = (
  slug: string,
  name: string,
  body?: string,
): {
  sourceId: string
  division: string
  slug: string
  path: string
  text: string
} => ({
  sourceId: `${CATALOG}/engineering/${slug}`,
  division: 'engineering',
  slug,
  path: `${DIRECTORY}/engineering/${slug}.md`,
  text: persona(name, body),
})

const importOne = async (
  entries: readonly ReturnType<typeof entry>[],
  options: { roleMap?: Record<string, string>; dryRun?: boolean } = {},
) => importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries, ...options }, 'operator')

describe('importCatalog', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  it('(a) creates a template for a persona nobody has imported and whose name is free', async (): Promise<void> => {
    const result = await importOne([entry('core-builder', 'Core Builder')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toHaveLength(1)
    expect(result.value.skipped).toEqual([])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })
    expect(row.name).toBe('Core Builder')
    expect(row.role).toBe('engineering')
    expect(row.description).toBe('Core Builder does one thing well.')
    expect(row.sourceDivision).toBe('engineering')
    expect(row.importedAt).not.toBeNull()
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect(
      (row.profile as string).startsWith(importedProfilePrefix(row.sourceId as string, row.importedAt as Date)),
    ).toBe(true)
    // A model choice is an operator decision, never an import's opinion (R3).
    expect(row.defaultModel).toBeNull()
    expect(row.provider).toBeNull()
  })

  it('(b) skips name_taken when a hand-made template already holds the name, and creates nothing', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Core Builder', role: 'backend' } })

    const result = await importOne([entry('core-builder', 'Core Builder')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toEqual([])
    expect(result.value.skipped).toEqual([
      {
        sourceId: `${CATALOG}/engineering/core-builder`,
        name: 'Core Builder',
        reason: 'name_taken',
        detail: 'a template named "Core Builder" already exists and was not imported from this catalog',
      },
    ])
    expect(await prisma.slaveTemplate.count()).toBe(1)
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')
  })

  it('(c) reports unchanged and writes nothing when the file has not changed', async (): Promise<void> => {
    const entries = [entry('core-builder', 'Core Builder')]
    await importOne(entries)
    const first = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })

    const result = await importOne(entries)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.unchanged.map((row) => row.sourceId)).toEqual([`${CATALOG}/engineering/core-builder`])
    expect(result.value.created).toEqual([])
    const second = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })
    expect(second.importedAt).toEqual(first.importedAt)
    expect(second.profile).toBe(first.profile)
  })

  it('(d) updates the profile, the description and both hashes when the file changed and nobody edited the profile', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const changed = entry('core-builder', 'Core Builder', 'You build the core module, its tests AND its documentation.')

    const result = await importOne([changed])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated.map((row) => row.sourceId)).toEqual([`${CATALOG}/engineering/core-builder`])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })
    expect(row.profile).toContain('AND its documentation')
    expect(row.sourceSha256).toBe(goalSha256(changed.text))
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
  })

  it('(d2) an update never writes name or role, and reports the role drift instead (E10)', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const template = await prisma.slaveTemplate.findFirstOrThrow()

    // The file changed AND the persona was renamed AND --role-map now says something else: the
    // only write is the profile side of the row. A template's name and role are set once -- every
    // worker already materialised from it copied the role into its runtimeRoles, which no update
    // here could reach.
    const renamed = entry('core-builder', 'Core Builder II', 'A rewritten body for the same file.')
    const result = await importOne([renamed], { roleMap: { engineering: 'frontend' } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated[0]?.roleDrift).toEqual({ stored: 'engineering', mapped: 'frontend' })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.name).toBe('Core Builder')
    expect(row.role).toBe('engineering')
    expect(row.profile).toContain('A rewritten body for the same file.')
  })

  it('(e) skips locally_edited when an operator wrote the profile since the last import', async (): Promise<void> => {
    const created = await importOne([entry('core-builder', 'Core Builder')])
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const templateId = created.value.created[0]?.templateId as string
    await setProfile({ templateId }, 'This is what I want this worker to be, in my own words.', 'operator')

    const result = await importOne([entry('core-builder', 'Core Builder', 'A different body entirely.')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('locally_edited')
    expect(result.value.updated).toEqual([])
    // The operator's words win, and the file's hash is NOT advanced -- the next import must still
    // see the same disagreement rather than silently accepting the file.
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })
    expect(row.profile).toBe('This is what I want this worker to be, in my own words.')
    expect(row.sourceSha256).not.toBe(goalSha256(persona('Core Builder', 'A different body entirely.')))
  })

  it('(e2) treats a CLEARED profile as locally edited too', async (): Promise<void> => {
    const created = await importOne([entry('core-builder', 'Core Builder')])
    if (!created.ok) return
    const templateId = created.value.created[0]?.templateId as string
    await setProfile({ templateId }, null, 'operator')

    const result = await importOne([entry('core-builder', 'Core Builder', 'A different body entirely.')])

    expect(result.ok && result.value.skipped[0]?.reason).toBe('locally_edited')
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })).profile).toBeNull()
  })

  it('(f) skips profile_too_long with the COMPOSED length, and never truncates', async (): Promise<void> => {
    const filler = 'The core module holds the rest of the system up. '
    const long = filler.repeat(400)

    const result = await importOne([entry('long-one', 'Long One', long)])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('profile_too_long')
    expect(result.value.skipped[0]?.detail).toMatch(/\d+ characters, over the 16000/)
    expect(await prisma.slaveTemplate.count()).toBe(0)
  })

  it('(g) skips invalid_persona with the parser reason', async (): Promise<void> => {
    const result = await importOne([
      {
        sourceId: `${CATALOG}/engineering/broken`,
        division: 'engineering',
        slug: 'broken',
        path: `${DIRECTORY}/engineering/broken.md`,
        text: '# no front matter here\n',
      },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped).toEqual([
      {
        sourceId: `${CATALOG}/engineering/broken`,
        name: null,
        reason: 'invalid_persona',
        detail: 'the file does not open with a --- front matter block',
      },
    ])
  })

  it('never deletes: a template whose persona has left the directory survives untouched', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder'), entry('helper', 'Helper')])

    await importOne([entry('core-builder', 'Core Builder')])

    expect(await prisma.slaveTemplate.count()).toBe(2)
  })

  it('one bad row does not stop the rest: every row is its own transaction', async (): Promise<void> => {
    const result = await importOne([
      { sourceId: `${CATALOG}/engineering/broken`, division: 'engineering', slug: 'broken', path: 'x', text: 'not a persona' },
      entry('core-builder', 'Core Builder'),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toHaveLength(1)
    expect(result.value.skipped).toHaveLength(1)
  })

  it('translates the role through --role-map at CREATION, and only reports a drift afterwards', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: 'backend' } })
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')

    // A template's role is set once (Decision 9), and a worker already materialised copied it into
    // its runtimeRoles -- so a later map is REPORTED, never written.
    const again = await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: 'frontend' } })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.unchanged[0]?.roleDrift).toEqual({ stored: 'backend', mapped: 'frontend' })
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')
  })

  it('records one CatalogImport row with the counters and the report', async (): Promise<void> => {
    const result = await importOne([
      entry('core-builder', 'Core Builder'),
      { sourceId: 'x', division: 'engineering', slug: 'broken', path: 'x', text: 'no' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.catalogImport.findUniqueOrThrow({ where: { id: result.value.importId as string } })
    expect(row).toMatchObject({
      catalog: CATALOG,
      directory: DIRECTORY,
      by: 'operator',
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 1,
    })
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime())
    expect((row.report as { skipped: { reason: string }[] }).skipped[0]?.reason).toBe('invalid_persona')
  })

  it('a dry run reads the database, decides everything and writes nothing', async (): Promise<void> => {
    const result = await importOne([entry('core-builder', 'Core Builder')], { dryRun: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dryRun).toBe(true)
    expect(result.value.importId).toBeNull()
    expect(result.value.created.map((row) => row.name)).toEqual(['Core Builder'])
    expect(result.value.created[0]?.templateId).toBeNull()
    expect(await prisma.slaveTemplate.count()).toBe(0)
    expect(await prisma.catalogImport.count()).toBe(0)
  })

  it('refuses an empty catalog and an unusable role map, writing nothing', async (): Promise<void> => {
    expect(await importOne([])).toEqual({ ok: false, error: { kind: 'catalog_empty', directory: DIRECTORY } })
    const bad = await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: '  ' } })
    expect(bad).toEqual({ ok: false, error: { kind: 'invalid_role_map', detail: 'the role for "engineering" is empty' } })
    expect(await prisma.catalogImport.count()).toBe(0)
  })
})

describe('listCatalogImports', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "CatalogImport", "SlaveTemplate" RESTART IDENTITY CASCADE')
  })

  it('returns the most recent runs first, and no more than the limit', async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) {
      await prisma.catalogImport.create({
        data: {
          catalog: CATALOG,
          directory: DIRECTORY,
          by: 'operator',
          startedAt: new Date(2026, 0, i + 1),
          finishedAt: new Date(2026, 0, i + 1),
          created: i,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          report: { created: [], updated: [], unchanged: [], skipped: [] },
        },
      })
    }

    const rows = await listCatalogImports(2)

    expect(rows.map((row) => row.created)).toEqual([2, 1])
  })
})
