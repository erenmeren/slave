import { importCatalog, setProfile, setProfileOverrides } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_MAX_CHARS } from '@slave-of-ai/domain'
import { listTemplates, listWorkforceCatalogPage, readTemplateProfileView } from '../../src/server/org.js'
import { GET as catalogGET } from '../../src/app/api/org/catalog/route.js'
import { GET as profileGET, PUT as profilePUT } from '../../src/app/api/org/templates/[templateId]/profile/route.js'
import { PATCH as overridesPATCH } from '../../src/app/api/org/templates/[templateId]/overrides/route.js'
import { DELETE as overrideDELETE } from '../../src/app/api/org/templates/[templateId]/overrides/[field]/route.js'

/**
 * The one `next/headers` mock this file needs (`route-principal.test.ts`'s hoisted-holder idiom).
 * Inert in every case but the accounts-mode one below: with no `SLAVEOFAI_SESSION_SECRET`,
 * `requirePrincipal` short-circuits before `cookies()` is ever reached.
 */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (): undefined => undefined }),
}))

const CATALOG = 'catalog-m46'
const SECRET = '0123456789abcdef0123456789abcdef'

const persona = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${name} does one thing well.\n---\n\n# ${name}\n\n${body}\n`

const entry = (slug: string, name: string, body: string) => ({
  sourceId: `${CATALOG}/engineering/${slug}`,
  division: 'engineering',
  slug,
  path: `/tmp/${CATALOG}/engineering/${slug}.md`,
  text: persona(name, body),
})

const templateParams = (templateId: string): { params: Promise<{ templateId: string }> } => ({
  params: Promise.resolve({ templateId }),
})

const fieldParams = (
  templateId: string,
  field: string,
): { params: Promise<{ templateId: string; field: string }> } => ({
  params: Promise.resolve({ templateId, field }),
})

const patchRequest = (body: unknown, raw?: string): Request =>
  new Request('http://x/api/org/templates/t/overrides', {
    method: 'PATCH',
    body: raw ?? JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const putRequest = (body: unknown, raw?: string): Request =>
  new Request('http://x/api/org/templates/t/profile', {
    method: 'PUT',
    body: raw ?? JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const catalogRequest = (query = ''): Request => new Request(`http://x/api/org/catalog${query}`)

async function coreBuilderId(): Promise<string> {
  return (await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Core Builder' } })).id
}

describe('the workforce catalog read model', () => {
  beforeEach(async (): Promise<void> => {
    // `SlaveTemplate` truncated CASCADE reaches `RunbookTemplate` (M48's `sourceTemplateId`) and
    // through it `Workspace` (`runbookId`) and everything below it. Both are NAMED rather than left
    // to the cascade, so the reach is documented rather than accidental (M48 final review, I2).
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    await importCatalog(
      {
        catalog: CATALOG,
        directory: `/tmp/${CATALOG}`,
        entries: [
          entry(
            'core-builder',
            'Core Builder',
            '## Core Capabilities\n- Design the module boundary\n\n## Domain Expertise\n- Load-bearing code\n',
          ),
          entry('verifier', 'Verifier', '## Core Capabilities\n- Run the work back\n'),
        ],
        revision: 'rev1',
        license: 'MIT',
      },
      'operator',
    )
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
  })

  afterEach((): void => {
    vi.unstubAllEnvs()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('hands the page ISO timestamps and the facets computed over every row', async (): Promise<void> => {
    const page = await listWorkforceCatalogPage()

    expect(page.rows.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
    const core = page.rows.find((row) => row.name === 'Core Builder')
    expect(typeof core?.importedAt).toBe('string')
    expect(core?.importedAt).toBe(new Date(core?.importedAt ?? '').toISOString())
    expect(core?.sourceRevision).toBe('rev1')
    expect(core?.sourceLicense).toBe('MIT')
    expect(core?.structured).toBe(true)
    expect(core?.source).toBe('imported')
    expect(page.facets.capabilities).toEqual(['Design the module boundary', 'Run the work back'])
    expect(page.facets.divisions).toEqual(['engineering'])
    // No `Date` survives the crossing into a `'use client'` prop -- the one thing this view exists
    // to do (`GoalVersionView.createdAt`'s idiom).
    for (const row of page.rows) {
      expect(row.importedAt === null || typeof row.importedAt === 'string').toBe(true)
    }
    expect(page.rows.find((row) => row.name === 'Hand Made')?.importedAt).toBeNull()
  })

  it('filters, and listTemplates is the unfiltered rows of the same read', async (): Promise<void> => {
    expect((await listWorkforceCatalogPage({ source: 'local' })).rows.map((row) => row.name)).toEqual(['Hand Made'])
    expect((await listWorkforceCatalogPage({ capability: 'Run the work back' })).rows.map((row) => row.name)).toEqual([
      'Verifier',
    ])
    const templates = await listTemplates()
    expect(templates.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
    // The shape `CompanyManager`'s `<select>` and the New slave drawer already take, unmoved.
    expect(templates[0]).toMatchObject({ id: expect.any(String), role: 'engineering', catalogSlaveCount: 0 })
  })

  it('keeps the facet menus whole even when a filter selects one row', async (): Promise<void> => {
    const page = await listWorkforceCatalogPage({ source: 'local' })

    expect(page.rows).toHaveLength(1)
    expect(page.facets.capabilities).toEqual(['Design the module boundary', 'Run the work back'])
  })

  it('reads one template’s whole profile, and reports a raw Markdown override', async (): Promise<void> => {
    const coreId = await coreBuilderId()
    await setProfileOverrides(coreId, { summary: 'Mine.' }, 'operator')

    const view = await readTemplateProfileView(coreId)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.value.effective?.summary).toBe('Mine.')
    expect(view.value.overridden).toEqual(['summary'])
    expect(view.value.rawOverride).toBe(false)
    expect(typeof view.value.markdown).toBe('string')

    await setProfile({ templateId: coreId }, 'my own words', 'operator')
    const after = await readTemplateProfileView(coreId)
    expect(after.ok && after.value.rawOverride).toBe(true)
  })

  it('refuses an unknown template rather than answering with an empty profile', async (): Promise<void> => {
    const missing = await readTemplateProfileView('00000000-0000-4000-8000-000000000000')

    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.kind).toBe('template_not_found')
  })

  describe('GET /api/org/catalog', () => {
    it('answers the whole catalog with its facets', async (): Promise<void> => {
      const response = await catalogGET(catalogRequest())

      expect(response.status).toBe(200)
      const body = (await response.json()) as { rows: { name: string }[]; facets: { divisions: string[] } }
      expect(body.rows.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
      expect(body.facets.divisions).toEqual(['engineering'])
    })

    it('narrows by the five params and ignores a source it does not know', async (): Promise<void> => {
      const filtered = await catalogGET(catalogRequest('?source=local'))
      expect(((await filtered.json()) as { rows: { name: string }[] }).rows.map((row) => row.name)).toEqual([
        'Hand Made',
      ])

      const lenient = await catalogGET(catalogRequest('?source=sideways'))
      expect(lenient.status).toBe(200)
      expect(((await lenient.json()) as { rows: { name: string }[] }).rows).toHaveLength(3)

      const byDivision = await catalogGET(catalogRequest('?division=engineering&q=verifier'))
      expect(((await byDivision.json()) as { rows: { name: string }[] }).rows.map((row) => row.name)).toEqual([
        'Verifier',
      ])
    })
  })

  describe('GET/PUT /api/org/templates/:id/profile', () => {
    it('reads one template’s whole effective spec', async (): Promise<void> => {
      const coreId = await coreBuilderId()

      const response = await profileGET(new Request('http://x'), templateParams(coreId))

      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        templateId: string
        name: string
        effective: { capabilities: string[] } | null
        upstream: unknown
        overrides: unknown
        markdown: string | null
        rawOverride: boolean
        overridden: string[]
      }
      expect(body.templateId).toBe(coreId)
      expect(body.name).toBe('Core Builder')
      expect(body.effective?.capabilities).toEqual(['Design the module boundary'])
      expect(body.overridden).toEqual([])
      expect(body.rawOverride).toBe(false)
      expect(typeof body.markdown).toBe('string')
    })

    it('is 404 for a template that does not exist', async (): Promise<void> => {
      const response = await profileGET(new Request('http://x'), templateParams('00000000-0000-4000-8000-000000000000'))

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: expect.any(String) })
    })

    // The one refusal this route has that is not about identity (M46 final wave, deferred minor):
    // a raw override longer than the cap a prompt is assembled under is declined by the verb, and
    // the shell turns that into a 409 rather than storing a profile no run could ever be given.
    it('is 409 profile_too_long for a raw override past the cap, and stores nothing', async (): Promise<void> => {
      const coreId = await coreBuilderId()
      const before = await readTemplateProfileView(coreId)

      const response = await profilePUT(putRequest({ profile: 'x'.repeat(PROFILE_MAX_CHARS + 1) }), templateParams(coreId))

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: string }
      expect(body.error).toContain(String(PROFILE_MAX_CHARS))
      const after = await readTemplateProfileView(coreId)
      expect(after.ok && after.value.markdown).toBe(before.ok ? before.value.markdown : null)
      expect(after.ok && after.value.rawOverride).toBe(false)
    })

    it('writes the raw Markdown override, and clears it back to the render', async (): Promise<void> => {
      const coreId = await coreBuilderId()

      const written = await profilePUT(putRequest({ profile: 'my own words' }), templateParams(coreId))
      expect(written.status).toBe(200)
      expect(await written.json()).toEqual({ ok: true })
      const after = await profileGET(new Request('http://x'), templateParams(coreId))
      const body = (await after.json()) as { markdown: string | null; rawOverride: boolean }
      expect(body.markdown).toBe('my own words')
      expect(body.rawOverride).toBe(true)

      const cleared = await profilePUT(putRequest({ profile: null }), templateParams(coreId))
      expect(cleared.status).toBe(200)
      expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: coreId } })).profile).toBeNull()
    })

    it('refuses a body that is not { profile: string | null } with 400, and an unknown template with 404', async (): Promise<void> => {
      const bad = await profilePUT(putRequest({}), templateParams(await coreBuilderId()))
      expect(bad.status).toBe(400)

      const malformed = await profilePUT(putRequest(undefined, 'not json'), templateParams(await coreBuilderId()))
      expect(malformed.status).toBe(400)

      const missing = await profilePUT(
        putRequest({ profile: 'x' }),
        templateParams('00000000-0000-4000-8000-000000000000'),
      )
      expect(missing.status).toBe(404)
    })
  })

  describe('PATCH /api/org/templates/:id/overrides', () => {
    it('merges a partial patch and reports what is overridden', async (): Promise<void> => {
      const coreId = await coreBuilderId()

      const first = await overridesPATCH(patchRequest({ patch: { summary: 'Mine.' } }), templateParams(coreId))
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ ok: true })

      const second = await overridesPATCH(
        patchRequest({ patch: { capabilities: ['Only this'] } }),
        templateParams(coreId),
      )
      expect(second.status).toBe(200)

      const view = await readTemplateProfileView(coreId)
      expect(view.ok && view.value.overridden).toEqual(['summary', 'capabilities'])
      expect(view.ok && view.value.effective?.summary).toBe('Mine.')
    })

    it('refuses a body without a patch object with 400, before the verb is called', async (): Promise<void> => {
      const coreId = await coreBuilderId()

      for (const body of [{}, { patch: 'summary' }, { patch: null }]) {
        const response = await overridesPATCH(patchRequest(body), templateParams(coreId))
        expect(response.status).toBe(400)
      }
      const malformed = await overridesPATCH(patchRequest(undefined, 'not json'), templateParams(coreId))
      expect(malformed.status).toBe(400)

      const view = await readTemplateProfileView(coreId)
      expect(view.ok && view.value.overridden).toEqual([])
    })

    it('is 409 for a field the profile does not have and for an unstructured template, 404 for an unknown one', async (): Promise<void> => {
      const coreId = await coreBuilderId()
      const handMade = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Hand Made' } })

      const unknownField = await overridesPATCH(patchRequest({ patch: { nonsense: 'x' } }), templateParams(coreId))
      expect(unknownField.status).toBe(409)

      const unstructured = await overridesPATCH(
        patchRequest({ patch: { summary: 'x' } }),
        templateParams(handMade.id),
      )
      expect(unstructured.status).toBe(409)

      const missing = await overridesPATCH(
        patchRequest({ patch: { summary: 'x' } }),
        templateParams('00000000-0000-4000-8000-000000000000'),
      )
      expect(missing.status).toBe(404)
    })
  })

  describe('DELETE /api/org/templates/:id/overrides/:field', () => {
    it('takes one field back to what the catalog says and leaves the others alone', async (): Promise<void> => {
      const coreId = await coreBuilderId()
      await setProfileOverrides(coreId, { summary: 'Mine.', capabilities: ['Only this'] }, 'operator')

      const response = await overrideDELETE(new Request('http://x', { method: 'DELETE' }), fieldParams(coreId, 'summary'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const view = await readTemplateProfileView(coreId)
      expect(view.ok && view.value.overridden).toEqual(['capabilities'])
      expect(view.ok && view.value.effective?.summary).toBe(view.ok ? view.value.upstream?.summary : undefined)
    })

    it('is 409 for a path segment that is not an overridable field, and 404 for an unknown template', async (): Promise<void> => {
      const coreId = await coreBuilderId()

      for (const field of ['nonsense', 'runtimeRole', 'source', '']) {
        const response = await overrideDELETE(
          new Request('http://x', { method: 'DELETE' }),
          fieldParams(coreId, field),
        )
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: expect.any(String) })
      }

      const missing = await overrideDELETE(
        new Request('http://x', { method: 'DELETE' }),
        fieldParams('00000000-0000-4000-8000-000000000000', 'summary'),
      )
      expect(missing.status).toBe(404)
    })
  })

  it('gates every one of the four routes on a session in accounts mode', async (): Promise<void> => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', SECRET)
    const coreId = await coreBuilderId()

    const responses = [
      await catalogGET(catalogRequest()),
      await profileGET(new Request('http://x'), templateParams(coreId)),
      await profilePUT(putRequest({ profile: 'x' }), templateParams(coreId)),
      await overridesPATCH(patchRequest({ patch: { summary: 'x' } }), templateParams(coreId)),
      await overrideDELETE(new Request('http://x', { method: 'DELETE' }), fieldParams(coreId, 'summary')),
    ]

    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'session revoked' })
    }
    const view = await readTemplateProfileView(coreId)
    expect(view.ok && view.value.overridden).toEqual([])
  })
})
