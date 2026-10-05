import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as people, POST as createPersonRoute } from '../../src/app/api/people/route.js'
import { DELETE as deletePersonRoute, GET as person } from '../../src/app/api/people/[personId]/route.js'
import { PUT as personProfile } from '../../src/app/api/people/[personId]/profile/route.js'
import { PUT as personRoster } from '../../src/app/api/people/[personId]/rosters/route.js'
import { PATCH as personSkills } from '../../src/app/api/people/[personId]/skills/route.js'
import { GET as personas, POST as createPersona } from '../../src/app/api/personas/route.js'
import { DELETE as deletePersona, GET as persona } from '../../src/app/api/personas/[templateId]/route.js'
import { POST as activation } from '../../src/app/api/personas/[templateId]/activation/route.js'
import { PATCH as overrides } from '../../src/app/api/personas/[templateId]/overrides/route.js'
import { DELETE as clearOverride } from '../../src/app/api/personas/[templateId]/overrides/[field]/route.js'
import { PUT as personaProfile } from '../../src/app/api/personas/[templateId]/profile/route.js'
import { PATCH as personaSkills } from '../../src/app/api/personas/[templateId]/skills/route.js'
import { GET as skills } from '../../src/app/api/skills/route.js'

/**
 * The People area's routes are thin envelopes over control functions. Each case pins the envelope
 * -- the status, the body's shape, what a bad body answers -- and leaves what the verb does to the
 * control package's own tests.
 */
afterAll(async () => {
  await prisma.$disconnect()
})

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown, url = 'http://test/api'): Request =>
  new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
const p = (personId: string): { params: Promise<{ personId: string }> } => ({ params: Promise.resolve({ personId }) })
const t = (templateId: string): { params: Promise<{ templateId: string }> } => ({ params: Promise.resolve({ templateId }) })

const SPEC = {
  identity: 'A careful builder',
  summary: 'Builds APIs.',
  mission: 'Ship working services.',
  runtimeRole: 'backend',
  capabilities: ['REST'],
  expertise: [],
  operatingPrinciples: ['Test first'],
  constraints: [],
  workflow: ['Read the request', 'Build it'],
  deliverables: [],
  successCriteria: [],
  collaborationHints: [],
  recommendedSkills: [],
  body: '',
  source: null,
}

let leadId = ''
let olderId = ''
let templateId = ''
let plainId = ''
let beaId = ''
let sqlId = ''
let cssId = ''

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SlaveRun", "Task", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Slave", "Person", "Team", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  leadId = (await prisma.workspace.create({ data: { name: 'Lead project', repoPath: '/tmp/lead', verifyCommands: ['true'], setupCommands: [], flow: 'lead' } })).id
  olderId = (await prisma.workspace.create({ data: { name: 'Older project', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [] } })).id
  templateId = (await prisma.slaveTemplate.create({ data: { name: 'Backend Architect', role: 'Backend Architect', description: 'Builds APIs.', sourceDivision: 'engineering', sourceId: 'engineering/backend', profileSpec: SPEC } })).id
  plainId = (await prisma.slaveTemplate.create({ data: { name: 'Plain', role: 'Tester', active: true } })).id
  const provider = await prisma.skillProvider.create({ data: { name: 'local' } })
  sqlId = (await prisma.skill.create({ data: { providerId: provider.id, name: 'sql', description: 'SQL' } })).id
  cssId = (await prisma.skill.create({ data: { providerId: provider.id, name: 'css', description: 'CSS' } })).id
  await prisma.templateSkill.create({ data: { templateId, skillId: cssId } })
  beaId = (await prisma.person.create({ data: { name: 'Bea', templateId } })).id
  await prisma.person.create({ data: { name: 'Free Person' } })
})

describe('GET /api/people', () => {
  it('answers a page of people with the totals and divisions', async () => {
    const response = await people(req('GET'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { people: { name: string }[]; total: number; all: number; divisions: unknown[] }
    expect(body.people.map((row) => row.name)).toEqual(['Bea', 'Free Person'])
    expect(body).toMatchObject({ total: 2, all: 2, offset: 0, limit: 48, divisions: [{ key: 'engineering', count: 1 }, { key: null, count: 1 }] })
  })

  it('passes the search, the filters and the page on', async () => {
    const names = async (query: string): Promise<string[]> => ((await (await people(req('GET', undefined, `http://test/api/people?${query}`))).json()) as { people: { name: string }[] }).people.map((row) => row.name)
    expect(await names('q=architect')).toEqual(['Bea'])
    expect(await names('division=none')).toEqual(['Free Person'])
    expect(await names(`skill=${cssId}`)).toEqual(['Bea'])
    expect(await names(`persona=${templateId}`)).toEqual(['Bea'])
    expect(await names('noSkills=1')).toEqual(['Free Person'])
    expect(await names('roster=1')).toEqual([])
    expect(await names('offset=1&limit=1')).toEqual(['Free Person'])
    expect(await names('offset=x&limit=-1')).toEqual(['Bea', 'Free Person'])
  })
})

describe('POST /api/people', () => {
  it('makes a person from a persona, named after it, and one from a name alone', async () => {
    const fromPersona = await createPersonRoute(req('POST', { templateId }))
    expect(fromPersona.status).toBe(200)
    const made = (await fromPersona.json()) as { ok: boolean; personId: string; name: string }
    expect(made).toMatchObject({ ok: true, name: 'Backend Architect' })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: made.personId } })).templateId).toBe(templateId)
    expect(await (await createPersonRoute(req('POST', { name: '  Solo  ' }))).json()).toMatchObject({ ok: true, name: 'Solo' })
  })

  it('puts the new person on a project\'s roster when asked', async () => {
    const response = await createPersonRoute(req('POST', { templateId, name: 'Cem', workspaceId: leadId }))
    const made = (await response.json()) as { personId: string }
    expect(response.status).toBe(200)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: leadId } })).leadRoster).toEqual([made.personId])
  })

  it('says the person exists when only the roster refused', async () => {
    const response = await createPersonRoute(req('POST', { name: 'Cem', workspaceId: olderId }))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; created: boolean; personId: string; name: string }
    expect(body).toMatchObject({ created: true, name: 'Cem' })
    expect(body.error).not.toBe('')
    expect(await prisma.person.findUnique({ where: { id: body.personId } })).not.toBeNull()
  })

  it('400s on a body that is not one, on neither a name nor a persona, and on a provider nobody runs', async () => {
    expect((await createPersonRoute(req('POST', 'nope'))).status).toBe(400)
    expect((await createPersonRoute(req('POST', {}))).status).toBe(400)
    expect((await createPersonRoute(req('POST', { name: '   ' }))).status).toBe(400)
    expect((await createPersonRoute(req('POST', { name: 'X', surprise: 1 }))).status).toBe(400)
    expect((await createPersonRoute(req('POST', { name: 'X', model: 'm', provider: 'abacus' }))).status).toBe(400)
  })

  it('404s on a persona or a project that is not there, 409s on a model with no provider, and makes nobody', async () => {
    expect((await createPersonRoute(req('POST', { templateId: UNKNOWN }))).status).toBe(404)
    expect((await createPersonRoute(req('POST', { name: 'X', workspaceId: UNKNOWN }))).status).toBe(404)
    expect((await createPersonRoute(req('POST', { name: 'X', model: 'some-model' }))).status).toBe(409)
    expect(await prisma.person.count()).toBe(2)
  })
})

describe('/api/people/:id', () => {
  it('answers the person whole, and 404 for nobody', async () => {
    const response = await person(req('GET'), p(beaId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { person: { name: string; skills: { name: string; state: string }[]; projects: unknown[]; profile: { effective: { workflow: string[] } } } }
    expect(body.person).toMatchObject({ name: 'Bea', role: 'Backend Architect', persona: { id: templateId }, ownInstructions: null })
    expect(body.person.skills).toEqual([expect.objectContaining({ name: 'css', state: 'persona' })])
    expect(body.person.projects).toEqual([{ id: leadId, name: 'Lead project', listed: false, full: false }])
    expect(body.person.profile.effective.workflow).toEqual(['Read the request', 'Build it'])
    const missing = await person(req('GET'), p(UNKNOWN))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toContain(UNKNOWN)
  })

  it('deletes the person, takes them off the rosters, and says what went', async () => {
    await prisma.workspace.update({ where: { id: leadId }, data: { leadRoster: [beaId] } })
    const response = await deletePersonRoute(req('DELETE'), p(beaId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, seats: 0, runs: 0, memories: 0, projects: [], rosters: 1 })
    expect(await prisma.person.findUnique({ where: { id: beaId } })).toBeNull()
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: leadId } })).leadRoster).toEqual([])
    expect((await deletePersonRoute(req('DELETE'), p(beaId))).status).toBe(404)
  })

  it('409s on a delete while a run of theirs is open', async () => {
    const team = await prisma.team.create({ data: { workspaceId: olderId, name: 'Engineering' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, personId: beaId, role: 'worker' } })
    await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'working', kind: 'implementation' } })
    expect((await deletePersonRoute(req('DELETE'), p(beaId))).status).toBe(409)
    expect(await prisma.person.findUnique({ where: { id: beaId } })).not.toBeNull()
  })
})

describe('PATCH /api/people/:id/skills', () => {
  it('grants, revokes and clears, answering the effective skills', async () => {
    const granted = await personSkills(req('PATCH', { grant: [sqlId], revoke: [cssId] }), p(beaId))
    expect(granted.status).toBe(200)
    expect(await granted.json()).toEqual({ ok: true, effective: [sqlId] })
    expect(await (await personSkills(req('PATCH', { clear: [cssId, sqlId] }), p(beaId))).json()).toEqual({ ok: true, effective: [cssId] })
  })

  it('400s on a bad body, 404s on nobody or a skill that is not there, 409s on a skill both granted and revoked', async () => {
    expect((await personSkills(req('PATCH', {}), p(beaId))).status).toBe(400)
    expect((await personSkills(req('PATCH', { grant: 'sql' }), p(beaId))).status).toBe(400)
    expect((await personSkills(req('PATCH', { grant: [sqlId] }), p(UNKNOWN))).status).toBe(404)
    expect((await personSkills(req('PATCH', { grant: [UNKNOWN] }), p(beaId))).status).toBe(404)
    expect((await personSkills(req('PATCH', { grant: [sqlId], revoke: [sqlId] }), p(beaId))).status).toBe(409)
  })
})

describe('PUT /api/people/:id/profile', () => {
  it('stores the person\'s own instructions trimmed, and clears them with null or an empty text', async () => {
    const response = await personProfile(req('PUT', { profile: '  Be brief.\n' }), p(beaId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: beaId } })).profile).toBe('Be brief.')
    expect((await personProfile(req('PUT', { profile: '   ' }), p(beaId))).status).toBe(200)
    expect((await prisma.person.findUniqueOrThrow({ where: { id: beaId } })).profile).toBeNull()
    await personProfile(req('PUT', { profile: 'Again.' }), p(beaId))
    await personProfile(req('PUT', { profile: null }), p(beaId))
    expect((await prisma.person.findUniqueOrThrow({ where: { id: beaId } })).profile).toBeNull()
  })

  it('400s on a bad body, 404s on nobody, 409s on a text past the limit', async () => {
    expect((await personProfile(req('PUT', {}), p(beaId))).status).toBe(400)
    expect((await personProfile(req('PUT', { profile: 3 }), p(beaId))).status).toBe(400)
    expect((await personProfile(req('PUT', { profile: 'x' }), p(UNKNOWN))).status).toBe(404)
    const tooLong = await personProfile(req('PUT', { profile: 'x'.repeat(60_000) }), p(beaId))
    expect(tooLong.status).toBe(409)
    expect(((await tooLong.json()) as { error: string }).error).not.toBe('')
  })
})

describe('PUT /api/people/:id/rosters', () => {
  it('puts the person on a lead project\'s roster and takes them off it', async () => {
    const on = await personRoster(req('PUT', { workspaceId: leadId, listed: true }), p(beaId))
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ ok: true, roster: [beaId] })
    expect(await (await personRoster(req('PUT', { workspaceId: leadId, listed: false }), p(beaId))).json()).toEqual({ ok: true, roster: [] })
  })

  it('400s on a bad body, 404s on a project or person that is not there, 409s on an older or an archived project', async () => {
    expect((await personRoster(req('PUT', { workspaceId: leadId }), p(beaId))).status).toBe(400)
    expect((await personRoster(req('PUT', { workspaceId: UNKNOWN, listed: true }), p(beaId))).status).toBe(404)
    expect((await personRoster(req('PUT', { workspaceId: leadId, listed: true }), p(UNKNOWN))).status).toBe(404)
    expect((await personRoster(req('PUT', { workspaceId: olderId, listed: true }), p(beaId))).status).toBe(409)
    await prisma.workspace.update({ where: { id: leadId }, data: { archivedAt: new Date() } })
    expect((await personRoster(req('PUT', { workspaceId: leadId, listed: true }), p(beaId))).status).toBe(409)
  })
})

describe('/api/personas', () => {
  it('answers a page of the catalogue, searched and filtered', async () => {
    const response = await personas(req('GET'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { personas: { name: string }[] }
    expect(body.personas.map((row) => row.name)).toEqual(['Backend Architect', 'Plain'])
    expect(body).toMatchObject({ total: 2, all: 2, activeCount: 1 })
    const names = async (query: string): Promise<string[]> => ((await (await personas(req('GET', undefined, `http://test/api/personas?${query}`))).json()) as { personas: { name: string }[] }).personas.map((row) => row.name)
    expect(await names('q=tester')).toEqual(['Plain'])
    expect(await names('division=engineering')).toEqual(['Backend Architect'])
    expect(await names('active=1')).toEqual(['Plain'])
    expect(await names('active=0')).toEqual(['Backend Architect'])
    expect(await names('offset=1')).toEqual(['Plain'])
  })

  it('makes a persona by hand, active at once, and refuses a taken name or an empty one', async () => {
    const response = await createPersona(req('POST', { name: ' Data Wrangler ', role: 'Analyst', description: 'Cleans data.' }))
    expect(response.status).toBe(200)
    const made = (await response.json()) as { ok: boolean; id: string }
    expect(await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ name: 'Data Wrangler', role: 'Analyst', description: 'Cleans data.', active: true })
    expect((await createPersona(req('POST', { name: 'Data Wrangler', role: 'Analyst' }))).status).toBe(409)
    expect((await createPersona(req('POST', { name: ' ', role: 'Analyst' }))).status).toBe(409)
    expect((await createPersona(req('POST', { name: 'X' }))).status).toBe(400)
  })
})

describe('/api/personas/:id', () => {
  it('answers the persona whole, and 404 for one that is not there', async () => {
    const response = await persona(req('GET'), t(templateId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { persona: { skills: unknown[]; profile: { effective: { mission: string } } } }
    expect(body.persona).toMatchObject({ name: 'Backend Architect', division: 'engineering', active: false, handMade: false, personCount: 1 })
    expect(body.persona.skills).toEqual([{ id: cssId, name: 'css', providerName: 'local', description: 'CSS', missing: false }])
    expect(body.persona.profile.effective.mission).toBe('Ship working services.')
    expect((await persona(req('GET'), t(UNKNOWN))).status).toBe(404)
  })

  it('deletes the persona and says how many people it left without one', async () => {
    const response = await deletePersona(req('DELETE'), t(templateId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, personsUnlinked: 1 })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: beaId } })).templateId).toBeNull()
    expect((await deletePersona(req('DELETE'), t(templateId))).status).toBe(404)
  })

  it('activates and deactivates, saying whether anything changed', async () => {
    expect(await (await activation(req('POST', { active: true }), t(templateId))).json()).toEqual({ ok: true, changed: true })
    expect(await (await activation(req('POST', { active: true }), t(templateId))).json()).toEqual({ ok: true, changed: false })
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })).active).toBe(true)
    expect((await activation(req('POST', { active: 'yes' }), t(templateId))).status).toBe(400)
    expect((await activation(req('POST', { active: false }), t(UNKNOWN))).status).toBe(404)
  })
})

describe('a persona\'s profile fields', () => {
  it('edits the workflow, re-renders the profile a session is given, and takes the field back', async () => {
    const edited = await overrides(req('PATCH', { patch: { workflow: ['Ask first', 'Then build', 'Then prove it'] } }), t(templateId))
    expect(edited.status).toBe(200)
    expect(await edited.json()).toEqual({ ok: true, overridden: ['workflow'] })
    const stored = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })
    expect(stored.profile).toContain('Then prove it')
    const read = (await (await persona(req('GET'), t(templateId))).json()) as { persona: { profile: { effective: { workflow: string[] }; upstream: { workflow: string[] }; overridden: string[] } } }
    expect(read.persona.profile.effective.workflow).toEqual(['Ask first', 'Then build', 'Then prove it'])
    expect(read.persona.profile.upstream.workflow).toEqual(['Read the request', 'Build it'])

    const cleared = await clearOverride(req('DELETE'), { params: Promise.resolve({ templateId, field: 'workflow' }) })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ ok: true, overridden: [] })
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })).profile).toContain('Build it')
  })

  it('400s on a body with no patch, 409s on a field nobody may edit or a persona with no structured profile, 404s on one that is not there', async () => {
    expect((await overrides(req('PATCH', {}), t(templateId))).status).toBe(400)
    expect((await overrides(req('PATCH', { patch: ['x'] }), t(templateId))).status).toBe(400)
    expect((await overrides(req('PATCH', { patch: { runtimeRole: 'boss' } }), t(templateId))).status).toBe(409)
    expect((await overrides(req('PATCH', { patch: { mission: 'x' } }), t(plainId))).status).toBe(409)
    expect((await overrides(req('PATCH', { patch: { mission: 'x' } }), t(UNKNOWN))).status).toBe(404)
    expect((await clearOverride(req('DELETE'), { params: Promise.resolve({ templateId, field: 'nonsense' }) })).status).toBe(409)
  })

  it('stores a hand-made persona\'s instructions as one text', async () => {
    const response = await personaProfile(req('PUT', { profile: 'You test things.' }), t(plainId))
    expect(response.status).toBe(200)
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: plainId } })).profile).toBe('You test things.')
    expect((await personaProfile(req('PUT', { profile: 7 }), t(plainId))).status).toBe(400)
    expect((await personaProfile(req('PUT', { profile: 'x' }), t(UNKNOWN))).status).toBe(404)
  })
})

describe('PATCH /api/personas/:id/skills', () => {
  it('sets the whole list or changes it, answering the list', async () => {
    expect(await (await personaSkills(req('PATCH', { add: [sqlId] }), t(templateId))).json()).toEqual({ ok: true, skills: [cssId, sqlId].toSorted() })
    expect(await (await personaSkills(req('PATCH', { remove: [cssId] }), t(templateId))).json()).toEqual({ ok: true, skills: [sqlId] })
    expect(await (await personaSkills(req('PATCH', { skillIds: [cssId] }), t(templateId))).json()).toEqual({ ok: true, skills: [cssId] })
  })

  it('400s on a bad body, 404s on a persona or a skill that is not there', async () => {
    expect((await personaSkills(req('PATCH', {}), t(templateId))).status).toBe(400)
    expect((await personaSkills(req('PATCH', { skillIds: [cssId], add: [sqlId] }), t(templateId))).status).toBe(400)
    expect((await personaSkills(req('PATCH', { add: [sqlId] }), t(UNKNOWN))).status).toBe(404)
    expect((await personaSkills(req('PATCH', { add: [UNKNOWN] }), t(templateId))).status).toBe(404)
  })
})

describe('GET /api/skills', () => {
  it('lists every skill with who has it', async () => {
    const response = await skills()
    expect(response.status).toBe(200)
    expect(((await response.json()) as { skills: { name: string; personCount: number; personaCount: number }[] }).skills.map((skill) => [skill.name, skill.personCount, skill.personaCount])).toEqual([
      ['css', 1, 1],
      ['sql', 0, 0],
    ])
  })
})
