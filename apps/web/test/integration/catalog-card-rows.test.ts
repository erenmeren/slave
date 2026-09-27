import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { listWorkforceCatalogPage } from '../../src/server/org.js'
import { GET as catalogGET } from '../../src/app/api/org/catalog/route.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
})

describe('workforce cards: catalog rows', () => {
  it('hands each row its linked skills with source, missing and process marks, by name', async () => {
    const personal = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const plugin = await prisma.skillProvider.create({ data: { name: 'plugin:superpowers' } })
    const pdf = await prisma.skill.create({ data: { providerId: personal.id, name: 'pdf', description: 'makes pdfs' } })
    const gone = await prisma.skill.create({
      data: { providerId: personal.id, name: 'archived', description: 'gone from disk', missingSince: new Date() },
    })
    const plans = await prisma.skill.create({ data: { providerId: plugin.id, name: 'writing-plans', description: 'plans' } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await prisma.templateSkill.createMany({
      data: [pdf, gone, plans].map((skill) => ({ templateId: template.id, skillId: skill.id })),
    })

    const row = (await listWorkforceCatalogPage()).rows[0]
    expect(row?.skills).toEqual([
      { skillId: gone.id, name: 'archived', providerName: 'personal', missing: true, process: false, state: 'persona' },
      { skillId: pdf.id, name: 'pdf', providerName: 'personal', missing: false, process: false, state: 'persona' },
      { skillId: plans.id, name: 'writing-plans', providerName: 'plugin:superpowers', missing: false, process: true, state: 'persona' },
    ])
    expect(row?.workflowPreview).toEqual({ steps: [], total: 0 })
  })

  it('answers a stale link with an unknown specialty as an empty page, not an error', async () => {
    await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev', capabilityKeys: ['frontend.styling'] } })

    const response = await catalogGET(new Request('http://x/api/org/catalog?specialty=no-such-domain&skills=none'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rows: unknown[]; total: number }
    expect(body.rows).toEqual([])
    expect(body.total).toBe(0)
  })
})
