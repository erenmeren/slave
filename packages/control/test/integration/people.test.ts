import { prisma } from '@slave-of-ai/db/client'
import { LEAD_ROSTER_MAX, LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deletePersonEverywhere, listPeople, listPersonas, listSkillUse, readPerson, readPersona, setPersonOnRoster } from '../../src/people.js'
import { truncateAll } from './helpers.js'

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

beforeEach(truncateAll)

afterAll(async () => {
  await prisma.$disconnect()
})

const project = (name: string, data: Record<string, unknown> = {}): Promise<{ id: string }> =>
  prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [], flow: 'lead', ...data } })

/** Two personas, three skills, four catalogue people, one project listing one of them. */
async function seed(): Promise<{ api: string; sql: string; css: string; backend: string; designer: string; bea: string; cem: string; dee: string; free: string; todo: string }> {
  const provider = await prisma.skillProvider.create({ data: { name: 'local' } })
  const skill = async (name: string, missing = false): Promise<string> => (await prisma.skill.create({ data: { providerId: provider.id, name, description: `About ${name}`, ...(missing ? { missingSince: new Date() } : {}) } })).id
  const [api, sql, css] = [await skill('api-design'), await skill('sql'), await skill('css')]
  const backend = (await prisma.slaveTemplate.create({ data: { name: 'Backend Architect', role: 'Backend Architect', description: ' Builds APIs. ', sourceDivision: 'engineering', sourceId: 'engineering/backend', active: true } })).id
  const designer = (await prisma.slaveTemplate.create({ data: { name: 'UI Designer', role: 'Designer', description: 'Draws screens.', sourceDivision: 'design', sourceId: 'design/ui', profileOverrides: { mission: 'Draw.' } } })).id
  await prisma.templateSkill.createMany({ data: [{ templateId: backend, skillId: api }, { templateId: backend, skillId: css }, { templateId: designer, skillId: css }] })
  const bea = (await prisma.person.create({ data: { name: 'Bea', templateId: backend, profile: 'Be brief.' } })).id
  await prisma.personSkill.createMany({ data: [{ personId: bea, skillId: sql, mode: 'granted' }, { personId: bea, skillId: css, mode: 'revoked' }] })
  const cem = (await prisma.person.create({ data: { name: 'Cem', templateId: backend } })).id
  const dee = (await prisma.person.create({ data: { name: 'Dee', templateId: designer } })).id
  const free = (await prisma.person.create({ data: { name: 'Free Person' } })).id
  const todo = (await project('Todo', { leadRoster: [bea] })).id
  return { api, sql, css, backend, designer, bea, cem, dee, free, todo }
}

describe('listPeople', () => {
  it('lists the catalogue people by name with their persona, skill count, own instructions and rosters', async () => {
    const ids = await seed()
    const page = await listPeople()
    expect(page.people).toEqual([
      { id: ids.bea, name: 'Bea', role: 'Backend Architect', division: 'engineering', description: 'Builds APIs.', templateId: ids.backend, skillCount: 2, ownInstructions: true, projects: [{ id: ids.todo, name: 'Todo' }], working: false },
      { id: ids.cem, name: 'Cem', role: 'Backend Architect', division: 'engineering', description: 'Builds APIs.', templateId: ids.backend, skillCount: 2, ownInstructions: false, projects: [], working: false },
      { id: ids.dee, name: 'Dee', role: 'Designer', division: 'design', description: 'Draws screens.', templateId: ids.designer, skillCount: 1, ownInstructions: false, projects: [], working: false },
      { id: ids.free, name: 'Free Person', role: null, division: null, description: '', templateId: null, skillCount: 0, ownInstructions: false, projects: [], working: false },
    ])
    expect(page).toMatchObject({ total: 4, all: 4, offset: 0, limit: 48 })
    expect(page.divisions).toEqual([{ key: 'engineering', count: 2 }, { key: 'design', count: 1 }, { key: null, count: 1 }])
  })

  it('searches and filters, and keeps the division counts over everybody', async () => {
    const ids = await seed()
    const names = async (filters: Parameters<typeof listPeople>[0]): Promise<string[]> => (await listPeople(filters)).people.map((person) => person.name)
    expect(await names({ q: 'backend APIS' })).toEqual(['Bea', 'Cem'])
    expect(await names({ q: 'dee' })).toEqual(['Dee'])
    expect(await names({ division: 'design' })).toEqual(['Dee'])
    expect(await names({ division: 'none' })).toEqual(['Free Person'])
    expect(await names({ templateId: ids.backend })).toEqual(['Bea', 'Cem'])
    // Bea revoked css and was granted sql; Cem and Dee have css from their personas.
    expect(await names({ skillId: ids.css })).toEqual(['Cem', 'Dee'])
    expect(await names({ skillId: ids.sql })).toEqual(['Bea'])
    expect(await names({ onRoster: true })).toEqual(['Bea'])
    expect(await names({ noSkills: true })).toEqual(['Free Person'])
    const filtered = await listPeople({ division: 'design' })
    expect(filtered).toMatchObject({ total: 1, all: 4 })
    expect(filtered.divisions).toHaveLength(3)
  })

  it('pages, and bounds what a request may ask for', async () => {
    await seed()
    const second = await listPeople({}, { offset: 1, limit: 2 })
    expect(second.people.map((person) => person.name)).toEqual(['Cem', 'Dee'])
    expect(second).toMatchObject({ total: 4, offset: 1, limit: 2 })
    expect(await listPeople({}, { offset: -3, limit: 0 })).toMatchObject({ offset: 0, limit: 1 })
    expect((await listPeople({}, { limit: 100_000 })).limit).toBe(200)
    expect((await listPeople({}, { offset: 99 })).people).toEqual([])
  })

  it('leaves out released people and the lead flow\'s own seats, does not count a missing skill, and says who is working', async () => {
    const ids = await seed()
    await prisma.person.create({ data: { name: 'Gone', releasedAt: new Date() } })
    const leadTeam = await prisma.team.create({ data: { workspaceId: ids.todo, name: LEAD_TEAM_NAME } })
    const lead = await prisma.person.create({ data: { name: 'Lead abc' } })
    await prisma.slave.create({ data: { teamId: leadTeam.id, personId: lead.id, role: 'Lead' } })
    await prisma.skill.update({ where: { id: ids.api }, data: { missingSince: new Date() } })
    const team = await prisma.team.create({ data: { workspaceId: ids.todo, name: 'Engineering' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, personId: ids.cem, role: 'worker' } })
    await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'working', kind: 'implementation' } })

    const page = await listPeople()
    expect(page.people.map((person) => [person.name, person.skillCount, person.working])).toEqual([
      ['Bea', 1, false],
      ['Cem', 1, true],
      ['Dee', 1, false],
      ['Free Person', 0, false],
    ])
  })
})

describe('readPerson', () => {
  it('answers null for nobody', async () => {
    expect(await readPerson(UNKNOWN)).toBeNull()
  })

  it('answers the person whole: persona, own instructions, every skill with its source, and the lead projects', async () => {
    const ids = await seed()
    await project('Archived', { archivedAt: new Date(), leadRoster: [ids.bea] })
    await project('Older', { flow: 'packages' })
    const full = Array.from({ length: LEAD_ROSTER_MAX }, (_, n) => `p-${String(n)}`)
    const packed = await project('Packed', { leadRoster: full })

    const person = await readPerson(ids.bea)
    expect(person).toMatchObject({
      id: ids.bea,
      name: 'Bea',
      role: 'Backend Architect',
      division: 'engineering',
      description: 'Builds APIs.',
      model: null,
      provider: null,
      working: false,
      persona: { id: ids.backend, name: 'Backend Architect', active: true },
      ownInstructions: 'Be brief.',
      footprint: { projects: [], runs: 0 },
    })
    expect(person?.profile).toMatchObject({ templateId: ids.backend, effective: null, overridden: [] })
    expect(person?.skills.map((row) => [row.name, row.state, row.fromPersona])).toEqual([
      ['api-design', 'persona', true],
      ['css', 'revoked', true],
      ['sql', 'granted', false],
    ])
    expect(person?.skills[0]).toMatchObject({ providerName: 'local', description: 'About api-design', missing: false })
    expect(person?.projects).toEqual([
      { id: packed.id, name: 'Packed', listed: false, full: true },
      { id: ids.todo, name: 'Todo', listed: true, full: false },
    ])
  })

  it('answers a person made from nothing with no persona and no profile', async () => {
    const ids = await seed()
    expect(await readPerson(ids.free)).toMatchObject({ role: null, division: null, persona: null, profile: null, ownInstructions: null, skills: [] })
  })
})

describe('setPersonOnRoster', () => {
  it('adds and removes a person, is quiet when already as asked, and drops an id nobody has any more', async () => {
    const ids = await seed()
    await prisma.workspace.update({ where: { id: ids.todo }, data: { leadRoster: [ids.bea, UNKNOWN] } })
    expect(await setPersonOnRoster(ids.cem, ids.todo, true)).toEqual({ ok: true, value: { roster: [ids.bea, ids.cem] } })
    expect(await setPersonOnRoster(ids.cem, ids.todo, true)).toEqual({ ok: true, value: { roster: [ids.bea, ids.cem] } })
    expect(await setPersonOnRoster(ids.bea, ids.todo, false)).toEqual({ ok: true, value: { roster: [ids.cem] } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ids.todo } })).leadRoster).toEqual([ids.cem])
  })

  it('refuses a project or a person that is not there, an older project and a full roster', async () => {
    const ids = await seed()
    expect(await setPersonOnRoster(ids.cem, UNKNOWN, true)).toMatchObject({ ok: false, error: { kind: 'workspace_not_found' } })
    expect(await setPersonOnRoster(UNKNOWN, ids.todo, true)).toMatchObject({ ok: false, error: { kind: 'person_not_found' } })
    const older = await project('Older', { flow: 'packages' })
    expect(await setPersonOnRoster(ids.cem, older.id, true)).toMatchObject({ ok: false, error: { kind: 'not_lead_flow' } })
    const crowd = await Promise.all(Array.from({ length: LEAD_ROSTER_MAX }, (_, n) => prisma.person.create({ data: { name: `Crowd ${String(n)}` } })))
    const packed = await project('Packed', { leadRoster: crowd.map((person) => person.id) })
    expect(await setPersonOnRoster(ids.cem, packed.id, true)).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster' } })
  })
})

describe('deletePersonEverywhere', () => {
  it('deletes the person and takes them off every roster that listed them', async () => {
    const ids = await seed()
    const other = await project('Other', { leadRoster: [ids.cem, ids.bea] })
    expect(await deletePersonEverywhere(ids.bea)).toEqual({ ok: true, value: { seats: 0, runs: 0, memories: 0, projects: [], rosters: 2 } })
    expect(await prisma.person.findUnique({ where: { id: ids.bea } })).toBeNull()
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ids.todo } })).leadRoster).toEqual([])
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: other.id } })).leadRoster).toEqual([ids.cem])
  })

  it('refuses nobody, and leaves the rosters alone', async () => {
    const ids = await seed()
    expect(await deletePersonEverywhere(UNKNOWN)).toMatchObject({ ok: false, error: { kind: 'person_not_found' } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ids.todo } })).leadRoster).toEqual([ids.bea])
  })
})

describe('listPersonas', () => {
  it('lists the catalogue by name with what each card shows, and the counts the filters show', async () => {
    const ids = await seed()
    const handMade = await prisma.slaveTemplate.create({ data: { name: 'Zed', role: 'Tester', active: true } })
    await prisma.person.create({ data: { name: 'Old Hand', templateId: ids.backend, releasedAt: new Date() } })
    const page = await listPersonas()
    expect(page.personas).toEqual([
      { id: ids.backend, name: 'Backend Architect', role: 'Backend Architect', division: 'engineering', description: 'Builds APIs.', active: true, customised: false, handMade: false, skillCount: 2, personCount: 2 },
      { id: ids.designer, name: 'UI Designer', role: 'Designer', division: 'design', description: 'Draws screens.', active: false, customised: true, handMade: false, skillCount: 1, personCount: 1 },
      { id: handMade.id, name: 'Zed', role: 'Tester', division: null, description: '', active: true, customised: false, handMade: true, skillCount: 0, personCount: 0 },
    ])
    expect(page).toMatchObject({ total: 3, all: 3, activeCount: 2, offset: 0, limit: 48 })
    expect(page.divisions).toEqual([{ key: 'design', count: 1 }, { key: 'engineering', count: 1 }, { key: null, count: 1 }])
  })

  it('searches, filters and pages', async () => {
    await seed()
    await prisma.slaveTemplate.create({ data: { name: 'Zed', role: 'Tester', active: true } })
    const names = async (filters: Parameters<typeof listPersonas>[0], page = {}): Promise<string[]> => (await listPersonas(filters, page)).personas.map((persona) => persona.name)
    expect(await names({ q: 'draws' })).toEqual(['UI Designer'])
    expect(await names({ division: 'engineering' })).toEqual(['Backend Architect'])
    expect(await names({ division: 'none' })).toEqual(['Zed'])
    expect(await names({ active: false })).toEqual(['UI Designer'])
    expect(await names({ active: true })).toEqual(['Backend Architect', 'Zed'])
    expect(await names({}, { offset: 2, limit: 5 })).toEqual(['Zed'])
  })
})

describe('readPersona', () => {
  it('answers the persona whole, and refuses one that is not there', async () => {
    const ids = await seed()
    const result = await readPersona(ids.designer)
    expect(result).toMatchObject({
      ok: true,
      value: { id: ids.designer, name: 'UI Designer', role: 'Designer', division: 'design', description: 'Draws screens.', active: false, handMade: false, sourcePath: null, personCount: 1, profile: { templateId: ids.designer, overridden: ['mission'] } },
    })
    expect(result.ok && result.value.skills).toEqual([{ id: ids.css, name: 'css', providerName: 'local', description: 'About css', missing: false }])
    expect(await readPersona(UNKNOWN)).toMatchObject({ ok: false, error: { kind: 'template_not_found' } })
  })
})

describe('listSkillUse', () => {
  it('lists every skill with the people who effectively have it and the personas that carry it', async () => {
    const ids = await seed()
    await prisma.skill.update({ where: { id: ids.sql }, data: { missingSince: new Date() } })
    expect((await listSkillUse()).map((skill) => [skill.name, skill.personCount, skill.personaCount, skill.missing])).toEqual([
      ['api-design', 2, 1, false],
      ['css', 2, 2, false],
      ['sql', 0, 0, true],
    ])
  })
})
