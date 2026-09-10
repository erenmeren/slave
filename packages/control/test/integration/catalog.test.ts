import { prisma } from '@slave-of-ai/db/client'
import {
  effectiveProfileSpec,
  goalSha256,
  importedProfilePrefix,
  profileSpecSchema,
  renderProfileSpec,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { importCatalog, listCatalogImports, listWorkforceCatalog, readTemplateProfile } from '../../src/catalog.js'
import { setProfile, setProfileOverrides } from '../../src/profile.js'

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
        detail: 'a template named "Core Builder" already exists and is not this persona\'s row',
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

  it('(c2) an unchanged FILE wins over a locally edited profile: nothing is read further, nothing written (D11)', async (): Promise<void> => {
    const entries = [entry('core-builder', 'Core Builder')]
    const created = await importOne(entries)
    if (!created.ok) return
    const templateId = created.value.created[0]?.templateId as string
    await setProfile({ templateId }, 'This is what I want this worker to be, in my own words.', 'operator')
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })

    // The SAME file, re-read. The stored profile disagrees with `profileSha256` -- a person wrote
    // it -- but the import is not being asked to replace that profile, so it has nothing to say
    // about it. `unchanged`, not `locally_edited`: the file sha is compared FIRST (D11), and this
    // case is the pin on that order.
    const result = await importOne(entries)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.unchanged.map((row) => row.templateId)).toEqual([templateId])
    expect(result.value.skipped).toEqual([])
    expect(result.value.updated).toEqual([])
    // Every column, byte for byte -- the operator's words included.
    expect(await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })).toEqual(before)
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

  it('no map -> no roleDrift on a re-import of a template created under a map', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: 'backend' } })
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')

    // A plain re-import (no --role-map at all) has nothing to compare the stored role against: a
    // division's fallback role ('engineering', the division name) is not a claim that the role
    // SHOULD be that, so it must never be reported as a drift.
    const again = await importOne([entry('core-builder', 'Core Builder')])

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.unchanged[0]?.roleDrift).toBeUndefined()
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

  it('trims both halves of every --role-map entry before anyone reads it', async (): Promise<void> => {
    const testing = {
      sourceId: `${CATALOG}/testing/prober`,
      division: 'testing',
      slug: 'prober',
      path: `${DIRECTORY}/testing/prober.md`,
      text: persona('Prober', 'You probe the seams between the modules.'),
    }

    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [testing], roleMap: { ' testing ': ' reviewer ' } },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Untrimmed, the key would have matched no division at all and the value would have been
    // written as a role with its spaces intact, which no scheduler query matches.
    expect(result.value.created[0]?.role).toBe('reviewer')
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('reviewer')
  })

  it('refuses a --role-map that names one division twice once trimmed', async (): Promise<void> => {
    const bad = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [entry('core-builder', 'Core Builder')],
        roleMap: { engineering: 'backend', ' engineering ': 'frontend' },
      },
      'operator',
    )

    expect(bad).toEqual({ ok: false, error: { kind: 'invalid_role_map', detail: 'the division "engineering" is named twice' } })
    expect(await prisma.slaveTemplate.count()).toBe(0)
  })

  it('a dry run decides an EXISTING template correctly and still writes nothing', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const before = await prisma.slaveTemplate.findFirstOrThrow()

    const result = await importOne([entry('core-builder', 'Core Builder', 'A rewritten body.')], { dryRun: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated.map((row) => row.templateId)).toEqual([before.id])
    expect(result.value.created).toEqual([])
    expect(await prisma.slaveTemplate.findFirstOrThrow()).toEqual(before)
    // Still just the ONE row the real import above wrote: a dry run records nothing (D6).
    expect(await prisma.catalogImport.count()).toBe(1)
  })

  it('records one CatalogImport row per RUN: two runs of the same import leave two', async (): Promise<void> => {
    const entries = [entry('core-builder', 'Core Builder')]

    await importOne(entries)
    await importOne(entries)

    // The second run created nothing -- the row is the record of a run, not of a change.
    const rows = await prisma.catalogImport.findMany({ orderBy: { startedAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.created, row.unchanged])).toEqual([
      [1, 0],
      [0, 1],
    ])
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

describe('importCatalog and the structured profile (M46)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  const structured = (slug: string, name: string, body?: string) => entry(slug, name, body)

  it('writes the mapped spec, the source columns and a profile rendered from them', async (): Promise<void> => {
    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder')],
        revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
        license: 'MIT',
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })
    expect(row.sourceRevision).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef')
    expect(row.sourceLicense).toBe('MIT')
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    expect(spec.success).toBe(true)
    if (!spec.success) return
    expect(spec.data.source).toEqual({
      repository: CATALOG,
      path: 'engineering/core-builder.md',
      revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
      license: 'MIT',
      importedAt: (row.importedAt as Date).toISOString(),
      mappingQuality: 'none',
    })
    expect(spec.data.runtimeRole).toBe('engineering')
    // The stored Markdown is the render of the effective spec, byte for byte.
    expect(row.profile).toBe(renderProfileSpec(spec.data))
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect(row.profileOverrides).toBeNull()
  })

  it('re-renders an updated row from the NEW upstream and the operator\u2019s untouched overrides, and counts them', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { summary: 'Mine, and it stays mine.' }, 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'You build the core module AND its documentation.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated).toHaveLength(1)
    expect(result.value.updated[0]?.overridesKept).toBe(1)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    // The override survived...
    expect(row.profileOverrides).toEqual({ summary: 'Mine, and it stays mine.' })
    expect(row.profile).toContain('Mine, and it stays mine.')
    // ...and the upstream half moved with the file.
    expect(row.profile).toContain('AND its documentation')
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
  })

  it('skips locally_edited for a RAW Markdown override and leaves the operator\u2019s words alone (R5)', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfile({ templateId: template.id }, 'This is what I want this worker to be, in my own words.', 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'A rewritten body for the same file.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('locally_edited')
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profile).toBe('This is what I want this worker to be, in my own words.')
    // The spec is NOT advanced either: the row is frozen until the operator resolves the
    // disagreement, exactly as M42 defined it.
    expect((row.profileSpec as { body: string }).body).not.toContain('A rewritten body')
  })

  it('a structured customisation is NOT locally_edited -- that is what re-stamping the hash buys', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { constraints: ['Mine'] }, 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'A rewritten body for the same file.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped).toEqual([])
    expect(result.value.updated[0]?.overridesKept).toBe(1)
  })

  it('reports overridesKept 0 on a row nobody has customised', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')

    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder', 'Changed.')] },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated[0]?.overridesKept).toBe(0)
  })
  /** A row exactly as an M42-era import left it: a composed Markdown profile with its hash, and
   *  no `profileSpec` at all. The shape erratum E22 is about. */
  const preM46Row = async (): Promise<{ id: string; profile: string }> => {
    const file = entry('core-builder', 'Core Builder')
    const importedAt = new Date('2026-09-01T00:00:00.000Z')
    const profile = `${importedProfilePrefix(file.sourceId, importedAt)}\n\n# Core Builder\n\nYou build the core module and its tests.`
    const row = await prisma.slaveTemplate.create({
      data: {
        name: 'Core Builder',
        role: 'engineering',
        description: 'Core Builder does one thing well.',
        profile,
        profileSha256: goalSha256(profile),
        sourceId: file.sourceId,
        sourceSha256: goalSha256(file.text),
        sourceDivision: 'engineering',
        importedAt,
      },
    })
    return { id: row.id, profile }
  }

  it('structures a row imported before M46 even though its file has not changed (E22)', async (): Promise<void> => {
    const before = await preM46Row()

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder')],
        revision: 'rev-m46',
        license: 'MIT',
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The FILE did not change, so the row is still `unchanged` -- it is the spec that was missing.
    expect(result.value.updated).toEqual([])
    expect(result.value.skipped).toEqual([])
    expect(result.value.unchanged[0]?.structured).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: before.id } })
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    expect(spec.success).toBe(true)
    if (!spec.success) return
    expect(row.profile).toBe(renderProfileSpec(spec.data))
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect(row.sourceRevision).toBe('rev-m46')
    expect(row.sourceLicense).toBe('MIT')
    // The file's own hash was already right and is not re-advanced by this.
    expect(row.sourceSha256).toBe(goalSha256(structured('core-builder', 'Core Builder').text))
  })

  it('leaves a pre-M46 row whose profile a person wrote ALONE, unchanged file and all (M42 c2)', async (): Promise<void> => {
    const created = await preM46Row()
    await setProfile({ templateId: created.id }, 'This is what I want this worker to be, in my own words.', 'operator')
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: created.id } })

    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')], revision: 'rev-m46' },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.unchanged[0]?.structured).toBeUndefined()
    // Every column, byte for byte: structuring a row is a WRITE, and this row is one no import may
    // write to until the operator resolves the disagreement.
    expect(await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before)
  })

  it('an unchanged file keeps the revision it came from (E22)', async (): Promise<void> => {
    await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')], revision: 'rev1' },
      'operator',
    )

    const again = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')], revision: 'rev2' },
      'operator',
    )

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.unchanged).toHaveLength(1)
    expect(again.value.unchanged[0]?.structured).toBeUndefined()
    const row = await prisma.slaveTemplate.findFirstOrThrow()
    expect(row.sourceRevision).toBe('rev1')
  })

  it('a dry run says a pre-M46 row WOULD be structured and writes nothing', async (): Promise<void> => {
    const before = await preM46Row()

    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')], dryRun: true },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.unchanged[0]?.structured).toBe(true)
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: before.id } })).profileSpec).toBeNull()
  })
})

describe('listWorkforceCatalog', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  const importTwo = async () =>
    importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [
          entry('core-builder', 'Core Builder', '## Core Capabilities\n- Design the module boundary\n\n## Domain Expertise\n- Load-bearing code'),
          entry('verifier', 'Verifier', '## Core Capabilities\n- Run the work back\n'),
        ],
        revision: 'rev1',
        license: 'MIT',
      },
      'operator',
    )

  it('returns one row per template with its summary, capabilities and source, plus the facets', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
    await importTwo()

    const page = await listWorkforceCatalog()

    expect(page.rows.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
    const core = page.rows.find((row) => row.name === 'Core Builder')
    expect(core?.source).toBe('imported')
    expect(core?.sourceRepository).toBe(CATALOG)
    expect(core?.capabilities).toContain('Design the module boundary')
    expect(core?.structured).toBe(true)
    expect(core?.rawOverride).toBe(false)
    expect(core?.overriddenFields).toEqual([])
    expect(page.rows.find((row) => row.name === 'Hand Made')?.source).toBe('local')
    expect(page.rows.find((row) => row.name === 'Hand Made')?.structured).toBe(false)
    expect(page.facets.divisions).toEqual(['engineering'])
    expect(page.facets.capabilities).toContain('Run the work back')
  })

  it('narrows by search text over name, summary, capabilities and expertise', async (): Promise<void> => {
    await importTwo()

    expect((await listWorkforceCatalog({ q: 'module boundary' })).rows.map((row) => row.name)).toEqual(['Core Builder'])
    expect((await listWorkforceCatalog({ q: 'load-bearing' })).rows.map((row) => row.name)).toEqual(['Core Builder'])
    expect((await listWorkforceCatalog({ q: 'verif' })).rows.map((row) => row.name)).toEqual(['Verifier'])
    expect((await listWorkforceCatalog({ q: 'nothing at all' })).rows).toEqual([])
  })

  it('narrows by capability, by division and by source, and keeps the facets whole', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
    // A hand-made template whose ROLE happens to spell a division. It is not in that division:
    // a division is a directory a catalog was imported from (plan erratum E22), and this row was
    // never imported from anything.
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made Engineer', role: 'engineering' } })
    await importTwo()

    expect((await listWorkforceCatalog({ capability: 'Run the work back' })).rows.map((row) => row.name)).toEqual(['Verifier'])
    expect((await listWorkforceCatalog({ division: 'engineering' })).rows.map((row) => row.name)).toEqual([
      'Core Builder',
      'Verifier',
    ])
    expect((await listWorkforceCatalog({ source: 'local' })).rows.map((row) => row.name)).toEqual([
      'Hand Made',
      'Hand Made Engineer',
    ])
    // Filtered rows, UNfiltered facets: a menu that collapsed to the one value already chosen
    // would be a menu you cannot change your mind in.
    expect((await listWorkforceCatalog({ source: 'local' })).facets.capabilities).toContain('Design the module boundary')
  })

  it('marks a raw Markdown override, and does not mark a hand-made template as one', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', profile: 'my own words' } })
    await importTwo()
    const core = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Core Builder' } })
    await setProfile({ templateId: core.id }, 'my own words', 'operator')

    const page = await listWorkforceCatalog()

    expect(page.rows.find((row) => row.name === 'Core Builder')?.rawOverride).toBe(true)
    // No spec, no upstream, nothing to override (plan erratum E5).
    expect(page.rows.find((row) => row.name === 'Hand Made')?.rawOverride).toBe(false)
  })
  it('narrows by recommended skill, and offers the skills and the mapping quality it found', async (): Promise<void> => {
    const skilled = {
      sourceId: `${CATALOG}/engineering/refactorer`,
      division: 'engineering',
      slug: 'refactorer',
      path: `${DIRECTORY}/engineering/refactorer.md`,
      text:
        '---\nname: Refactorer\ndescription: Refactorer does one thing well.\nskills: refactoring, code-review\n---\n\n' +
        '# Refactorer\n\n## Core Mission\n\nKeep the seams clean.\n\n' +
        '## Core Capabilities\n- Split a module in two\n\n## Domain Expertise\n- Legacy code\n\n' +
        '## Critical Rules\n- You MUST never leave a red test behind\n',
    }
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [skilled], revision: 'rev1' }, 'operator')
    await importTwo()

    const page = await listWorkforceCatalog({ skill: 'refactoring' })

    expect(page.rows.map((row) => row.name)).toEqual(['Refactorer'])
    expect(page.rows[0]?.recommendedSkills).toEqual(['refactoring', 'code-review'])
    // Four canonical slots filled is `partial` (the mapper's own threshold), and the LABEL for it
    // is the drawer's business -- the row carries the enum.
    expect(page.rows[0]?.mappingQuality).toBe('partial')
    expect(page.facets.skills).toEqual(['code-review', 'refactoring'])
  })

  it('marks a CLEARED profile as a raw override, exactly as the importer calls it locally_edited', async (): Promise<void> => {
    await importTwo()
    const core = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Core Builder' } })
    await setProfile({ templateId: core.id }, null, 'operator')

    const page = await listWorkforceCatalog()
    expect(page.rows.find((row) => row.name === 'Core Builder')?.rawOverride).toBe(true)

    // The same predicate, reached through the importer: a changed file for that row is skipped.
    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [entry('core-builder', 'Core Builder', 'A rewritten body for the same file.')],
      },
      'operator',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('locally_edited')
  })
})

describe('readTemplateProfile', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  it('hands back both halves, the merge and the stored Markdown', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { summary: 'Mine.' }, 'operator')

    const result = await readTemplateProfile(template.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.overrides).toEqual({ summary: 'Mine.' })
    expect(result.value.effective?.summary).toBe('Mine.')
    expect(result.value.upstream?.summary).not.toBe('Mine.')
    expect(result.value.markdown).toBe(renderProfileSpec(effectiveProfileSpec(result.value.upstream, result.value.overrides)))
    expect(result.value.overridden).toEqual(['summary'])
    expect(result.value.rawOverride).toBe(false)
  })

  it('answers for a hand-made template with a null spec rather than refusing', async (): Promise<void> => {
    const handMade = await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', profile: 'mine' } })

    const result = await readTemplateProfile(handMade.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.upstream).toBeNull()
    expect(result.value.effective).toBeNull()
    expect(result.value.markdown).toBe('mine')
  })

  it('refuses an id nobody has', async (): Promise<void> => {
    const result = await readTemplateProfile('11111111-1111-1111-1111-111111111111')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('template_not_found')
  })
  it('says rawOverride when a person wrote the Markdown over a structured profile', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfile({ templateId: template.id }, 'my own words', 'operator')

    const result = await readTemplateProfile(template.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rawOverride).toBe(true)
    expect(result.value.markdown).toBe('my own words')
    // The upstream half is still there to go back to -- that is what makes the raw override
    // recoverable rather than a one-way door.
    expect(result.value.upstream?.body).not.toBe('my own words')
  })

  it('says rawOverride for a CLEARED profile too (fix round 1, minor 2)', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfile({ templateId: template.id }, null, 'operator')

    const result = await readTemplateProfile(template.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rawOverride).toBe(true)
    expect(result.value.markdown).toBeNull()
  })
})
