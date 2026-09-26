import { beforeEach, describe, expect, it } from 'vitest'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec } from '@slave-of-ai/domain'
import { assignPerson, syncCapabilityTaxonomy } from '@slave-of-ai/control'
import { listPeoplePage, listSkillCatalogue, PEOPLE_PAGE_SIZE } from '../../src/server/persons.js'
import { GET as peopleGET } from '../../src/app/api/persons/route.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
  await syncCapabilityTaxonomy()
})

async function skill(name: string, over: { readonly provider?: string; readonly missing?: boolean } = {}): Promise<string> {
  const providerName = over.provider ?? 'personal'
  const provider = await prisma.skillProvider.upsert({ where: { name: providerName }, create: { name: providerName }, update: {} })
  const row = await prisma.skill.create({
    data: {
      providerId: provider.id,
      name,
      description: `${name} does a thing`,
      ...(over.missing === true ? { missingSince: new Date() } : {}),
    },
  })
  return row.id
}

async function persona(
  name: string,
  over: { readonly division?: string; readonly searchText?: string; readonly workflow?: readonly string[]; readonly skills?: readonly string[] } = {},
): Promise<string> {
  const row = await prisma.slaveTemplate.create({
    data: {
      name,
      role: 'dev',
      sourceDivision: over.division ?? null,
      searchText: over.searchText ?? name.toLowerCase(),
      ...(over.workflow === undefined
        ? {}
        : { profileSpec: { ...emptyProfileSpec(), workflow: [...over.workflow] } as unknown as Prisma.InputJsonValue }),
    },
  })
  if (over.skills !== undefined) {
    await prisma.templateSkill.createMany({ data: over.skills.map((skillId) => ({ templateId: row.id, skillId })) })
  }
  return row.id
}

async function person(
  name: string,
  over: { readonly templateId?: string; readonly capabilities?: readonly string[]; readonly released?: boolean } = {},
): Promise<string> {
  const row = await prisma.person.create({
    data: {
      name,
      capabilities: [...(over.capabilities ?? [])],
      ...(over.templateId === undefined ? {} : { templateId: over.templateId }),
      ...(over.released === true ? { releasedAt: new Date(), releaseReason: 'done' } : {}),
    },
  })
  return row.id
}

const names = (view: { readonly rows: readonly { readonly name: string }[] }): string[] => view.rows.map((row) => row.name)

describe('listPeoplePage', () => {
  it('hands each person their chips: origins, a revoked inherited skill, a missing one', async () => {
    const pdf = await skill('pdf')
    const sql = await skill('sql')
    const gone = await skill('archived', { missing: true })
    const builder = await persona('Builder', { division: 'engineering', skills: [pdf, sql] })
    const atlas = await person('Atlas', { templateId: builder })
    await prisma.personSkill.createMany({
      data: [
        { personId: atlas, skillId: sql, mode: 'revoked' },
        { personId: atlas, skillId: gone, mode: 'granted' },
      ],
    })

    const row = (await listPeoplePage()).rows.find((one) => one.name === 'Atlas')
    expect(row?.skills.map((one) => [one.name, one.state, one.missing])).toEqual([
      ['archived', 'person', true],
      ['pdf', 'persona', false],
      ['sql', 'revoked', false],
    ])
    expect(row?.skillCount).toBe(2)
    expect(row?.division).toBe('engineering')
    expect(row?.personaName).toBe('Builder')
  })

  it('searches the name, the persona text and a skill name', async () => {
    const maker = await skill('pdf-maker')
    const builder = await persona('Builder', { searchText: 'builds the core' })
    await person('Atlas', { templateId: builder })
    const zed = await person('Zed')
    await prisma.personSkill.create({ data: { personId: zed, skillId: maker, mode: 'granted' } })

    expect(names(await listPeoplePage({ q: 'atl' }))).toEqual(['Atlas'])
    expect(names(await listPeoplePage({ q: 'core' }))).toEqual(['Atlas'])
    expect(names(await listPeoplePage({ q: 'PDF-maker' }))).toEqual(['Zed'])
  })

  it('search over a persona default skill excludes a skill this person revoked (F14)', async () => {
    const widget = await skill('widget')
    const builder = await persona('Builder', { skills: [widget] })
    await person('Kept', { templateId: builder })
    const revoked = await person('Revoked', { templateId: builder })
    await prisma.personSkill.create({ data: { personId: revoked, skillId: widget, mode: 'revoked' } })

    expect(names(await listPeoplePage({ q: 'widget' }))).toEqual(['Kept'])
  })

  it('search also matches a capability key or label containing q (F14)', async () => {
    await person('Sty', { capabilities: ['frontend.styling'] })
    await person('Other', { capabilities: ['qa.test-strategy'] })

    // "Styling and layout" is the taxonomy LABEL of frontend.styling -- "layout" is in the label
    // and nowhere in the key, so a match here can only have come from the label.
    expect(names(await listPeoplePage({ q: 'layout' }))).toEqual(['Sty'])
    expect(names(await listPeoplePage({ q: 'frontend.styling' }))).toEqual(['Sty'])
  })

  it('counts specialty domains over people and filters by one; an unknown domain is empty', async () => {
    await person('Ada', { capabilities: ['frontend.styling', 'frontend.accessibility'] })
    await person('Bo', { capabilities: ['frontend.styling', 'qa.test-strategy'] })

    const all = await listPeoplePage()
    expect(all.facets.domains).toEqual([
      { domain: 'frontend', count: 2 },
      { domain: 'qa', count: 1 },
    ])
    expect(names(await listPeoplePage({ specialty: 'qa' }))).toEqual(['Bo'])
    const unknown = await listPeoplePage({ specialty: 'no-such-domain' })
    expect(unknown.rows).toEqual([])
    expect(unknown.total).toBe(0)
  })

  it('"no skills": nobody granted anything, and every inherited skill revoked counts as none', async () => {
    const pdf = await skill('pdf')
    const builder = await persona('Builder', { skills: [pdf] })
    await person('Equipped', { templateId: builder })
    const revokedAll = await person('Revoked', { templateId: builder })
    await prisma.personSkill.create({ data: { personId: revokedAll, skillId: pdf, mode: 'revoked' } })
    await person('Bare')
    const granted = await person('Granted')
    await prisma.personSkill.create({ data: { personId: granted, skillId: pdf, mode: 'granted' } })

    expect(names(await listPeoplePage({ noSkills: true }))).toEqual(['Bare', 'Revoked'])
    // The skill filter respects the same revoke.
    expect(names(await listPeoplePage({ skillId: pdf }))).toEqual(['Equipped', 'Granted'])
    // An unknown skill id is a stale link: empty, never an error.
    expect((await listPeoplePage({ skillId: 'no-such-skill' })).total).toBe(0)
  })

  it('the three segments, the division and the department', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/Alpha', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const builder = await persona('Builder', { division: 'engineering' })
    await person('Pooled', { templateId: builder })
    const seated = await person('Seated')
    const seat = await assignPerson(seated, team.id)
    expect(seat.ok).toBe(true)
    await person('Released', { released: true })
    const company = await prisma.company.create({ data: { name: 'Co' } })
    const department = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
    await prisma.companyTeamMember.create({ data: { companyTeamId: department.id, personId: seated } })

    expect(names(await listPeoplePage({ state: 'pool' }))).toEqual(['Pooled'])
    expect(names(await listPeoplePage({ state: 'assigned' }))).toEqual(['Seated'])
    expect(names(await listPeoplePage({ state: 'released' }))).toEqual(['Released'])
    expect(names(await listPeoplePage({ division: 'engineering' }))).toEqual(['Pooled'])
    expect(names(await listPeoplePage({ department: department.id }))).toEqual(['Seated'])
    expect((await listPeoplePage()).facets.divisions).toEqual(['engineering'])
  })

  it('pages a pool of hundreds a hundred at a time, and the total counts every one', async () => {
    await prisma.person.createMany({
      data: Array.from({ length: 250 }, (_, index) => ({ name: `Pool ${String(index).padStart(3, '0')}` })),
    })

    const first = await listPeoplePage()
    expect(first.rows).toHaveLength(PEOPLE_PAGE_SIZE)
    expect(first.total).toBe(250)
    expect(first.nextCursor).toBe(first.rows.at(-1)?.personId)
    const second = await listPeoplePage({}, { cursor: first.nextCursor ?? '' })
    expect(second.rows[0]?.name).toBe('Pool 100')
    const third = await listPeoplePage({}, { cursor: second.nextCursor ?? '' })
    expect(third.rows).toHaveLength(50)
    expect(third.nextCursor).toBeNull()
  })

  it("previews the persona's workflow, and nothing for a person made from nothing", async () => {
    const builder = await persona('Builder', { workflow: ['Read', 'Plan', 'Build', 'Test'] })
    await person('Atlas', { templateId: builder })
    await person('Zed')

    const rows = (await listPeoplePage()).rows
    expect(rows.find((row) => row.name === 'Atlas')?.workflowPreview).toEqual({ steps: ['Read', 'Plan', 'Build'], total: 4 })
    expect(rows.find((row) => row.name === 'Zed')?.workflowPreview).toEqual({ steps: [], total: 0 })
  })
})

describe('GET /api/persons', () => {
  it('reads the filters and the cursor off the URL', async () => {
    await person('Pooled')
    await person('Released', { released: true })

    const response = await peopleGET(new Request('http://x/api/persons?state=released&cursor='))
    expect(response.status).toBe(200)
    expect(names((await response.json()) as { rows: { name: string }[] })).toEqual(['Released'])
  })
})

describe('listSkillCatalogue', () => {
  it('carries the description and whether the skill is missing, for the picker', async () => {
    await skill('archived', { missing: true })
    expect(await listSkillCatalogue()).toEqual([
      expect.objectContaining({ name: 'archived', providerName: 'personal', description: 'archived does a thing', missing: true }),
    ])
  })
})
