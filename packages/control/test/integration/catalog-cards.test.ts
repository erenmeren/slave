import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec, type ProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { listCapabilities, syncCapabilityTaxonomy } from '../../src/capability.js'
import { capabilityKeysInDomain, listWorkforceCatalog } from '../../src/catalog.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
  // The taxonomy is a SEEDED table this file only reads; re-syncing is cheap and makes the domain
  // counts below independent of whatever another file did to it (`capability.test.ts`'s idiom).
  await syncCapabilityTaxonomy()
})

const template = async (
  name: string,
  over: { readonly capabilityKeys?: readonly string[]; readonly spec?: ProfileSpec; readonly overrides?: object } = {},
): Promise<string> => {
  const row = await prisma.slaveTemplate.create({
    data: {
      name,
      role: 'dev',
      capabilityKeys: [...(over.capabilityKeys ?? [])],
      searchText: name.toLowerCase(),
      ...(over.spec === undefined ? {} : { profileSpec: over.spec as unknown as Prisma.InputJsonValue }),
      ...(over.overrides === undefined ? {} : { profileOverrides: over.overrides as Prisma.InputJsonValue }),
    },
  })
  return row.id
}

const linkSkill = async (templateId: string, name: string): Promise<void> => {
  const provider = await prisma.skillProvider.upsert({ where: { name: 'personal' }, create: { name: 'personal' }, update: {} })
  const skill = await prisma.skill.create({ data: { providerId: provider.id, name, description: `${name} does a thing` } })
  await prisma.templateSkill.create({ data: { templateId, skillId: skill.id } })
}

describe('workforce cards: the catalog read', () => {
  it('counts each capability domain once per persona, most matches first', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling', 'frontend.accessibility'] })
    await template('Bravo', { capabilityKeys: ['frontend.styling', 'backend.services'] })
    await template('Charlie', { capabilityKeys: ['qa.test-strategy'] })

    expect((await listWorkforceCatalog()).facets.domains).toEqual([
      { domain: 'frontend', count: 2 },
      { domain: 'backend', count: 1 },
      { domain: 'qa', count: 1 },
    ])
  })

  it('filters by specialty: any key in the domain matches', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling'] })
    await template('Bravo', { capabilityKeys: ['backend.services', 'frontend.accessibility'] })
    await template('Charlie', { capabilityKeys: ['qa.test-strategy'] })

    const page = await listWorkforceCatalog({ specialty: 'frontend' })
    expect(page.rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo'])
    expect(page.total).toBe(2)
  })

  it('answers an unknown specialty with no rows, never an error', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling'] })

    const page = await listWorkforceCatalog({ specialty: 'no-such-domain' })
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
  })

  it('knows a domain by its keys', async () => {
    const keys = capabilityKeysInDomain('frontend', await listCapabilities())
    expect(keys).toContain('frontend.styling')
    expect(keys.every((key) => key.startsWith('frontend.'))).toBe(true)
    expect(capabilityKeysInDomain('no-such-domain', await listCapabilities())).toEqual([])
  })

  it('"no skills" keeps only the personas nobody has equipped', async () => {
    const alpha = await template('Alpha')
    await template('Bravo')
    await linkSkill(alpha, 'pdf')

    expect((await listWorkforceCatalog({ noSkills: true })).rows.map((row) => row.name)).toEqual(['Bravo'])
  })

  it('finds a persona by the NAME of a skill linked to it', async () => {
    const alpha = await template('Alpha')
    await template('Bravo')
    await linkSkill(alpha, 'pdf-maker')

    expect((await listWorkforceCatalog({ q: 'PDF-maker' })).rows.map((row) => row.name)).toEqual(['Alpha'])
  })

  it('previews the EFFECTIVE workflow: an override wins, a missing spec is empty', async () => {
    await template('Alpha', {
      spec: { ...emptyProfileSpec(), workflow: ['Upstream one', 'Upstream two'] },
      overrides: { workflow: ['Read', 'Plan', 'Build', 'Ship'] },
    })
    await template('Bravo')

    const rows = (await listWorkforceCatalog()).rows
    expect(rows.find((row) => row.name === 'Alpha')?.workflowPreview).toEqual({ steps: ['Read', 'Plan', 'Build'], total: 4 })
    expect(rows.find((row) => row.name === 'Bravo')?.workflowPreview).toEqual({ steps: [], total: 0 })
  })
})
