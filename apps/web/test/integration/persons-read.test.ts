import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { assignPerson, createPerson, setPersonSkills, setTemplateSkills } from '@slave-of-ai/control'
import { listPersons, listPoolCandidates, readPerson } from '../../src/server/persons.js'
import { DELETE as deletePersonRoute } from '../../src/app/api/persons/[personId]/route.js'
import { POST as assignRoute } from '../../src/app/api/persons/[personId]/assign/route.js'
import { POST as unassignRoute } from '../../src/app/api/persons/[personId]/unassign/route.js'
import { PATCH as personSkillsRoute } from '../../src/app/api/persons/[personId]/skills/route.js'
import { PATCH as templateSkillsRoute } from '../../src/app/api/org/templates/[templateId]/skills/route.js'
import { POST as newPersonRoute } from '../../src/app/api/org/slaves/route.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
})

async function project(name: string): Promise<{ workspaceId: string; teamId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

function post(body: unknown): Request {
  return new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })
}

function patch(body: unknown): Request {
  return new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) })
}

describe('listPersons', () => {
  it('gives one row per person, with their seats and the word for where they are', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const seated = await createPerson({ name: 'Seated' })
    const pooled = await createPerson({ name: 'Pooled' })
    if (!seated.ok || !pooled.ok) throw new Error('setup')
    await assignPerson(seated.value.personId, a.teamId)
    await assignPerson(seated.value.personId, b.teamId)

    const rows = await listPersons()
    expect(rows.map((row) => row.name)).toEqual(['Pooled', 'Seated'])
    const seatedRow = rows.find((row) => row.name === 'Seated')
    expect(seatedRow?.state).toBe('assigned')
    expect(seatedRow?.stateLabel).toBe('ASSIGNED')
    expect(seatedRow?.seats.map((seat) => seat.projectName).toSorted()).toEqual(['Alpha', 'Beta'])
    const pooledRow = rows.find((row) => row.name === 'Pooled')
    expect(pooledRow?.state).toBe('pool')
    expect(pooledRow?.seats).toEqual([])
  })

  it('a closed seat is not a project the person works on', async () => {
    const a = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, a.teamId)
    if (!seated.ok) throw new Error('setup')
    await prisma.slave.update({ where: { id: seated.value.slaveId }, data: { closedAt: new Date() } })

    const rows = await listPersons()
    expect(rows[0]?.state).toBe('pool')
    expect(rows[0]?.seats).toEqual([])
  })
})

describe('readPerson', () => {
  it('names the level each override came from and marks a revoked persona skill', async () => {
    const providerRow = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const pdf = await prisma.skill.create({ data: { providerId: providerRow.id, name: 'pdf', description: 'd' } })
    const sql = await prisma.skill.create({ data: { providerId: providerRow.id, name: 'sql', description: 'd' } })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Builder', role: 'dev', profile: 'template persona', defaultModel: 'haiku', provider: 'claude_code' },
    })
    await setTemplateSkills(template.id, [pdf.id, sql.id])
    const person = await createPerson({ templateId: template.id, name: 'Atlas', profile: 'person persona' })
    if (!person.ok) throw new Error('setup')
    await setPersonSkills(person.value.personId, { revoke: [sql.id] })

    const detail = await readPerson(person.value.personId)
    expect(detail?.profile).toEqual({ text: 'person persona', origin: 'person' })
    expect(detail?.model).toEqual({ value: 'haiku', origin: 'template' })
    expect(detail?.skills).toEqual([
      { skillId: pdf.id, name: 'pdf', providerName: 'personal', state: 'persona' },
      { skillId: sql.id, name: 'sql', providerName: 'personal', state: 'revoked' },
    ])
  })

  it('is null for somebody who is not there', async () => {
    expect(await readPerson('nope')).toBeNull()
  })
})

describe('listPoolCandidates', () => {
  it('offers people who hold no OPEN seat on this project, and nobody released', async () => {
    const a = await project('Alpha')
    const here = await createPerson({ name: 'Here' })
    const elsewhere = await createPerson({ name: 'Elsewhere' })
    const gone = await createPerson({ name: 'Gone', lifecycle: 'ephemeral' })
    if (!here.ok || !elsewhere.ok || !gone.ok) throw new Error('setup')
    await assignPerson(here.value.personId, a.teamId)
    await prisma.person.update({ where: { id: gone.value.personId }, data: { releasedAt: new Date() } })

    const candidates = await listPoolCandidates(a.workspaceId)
    expect(candidates.map((row) => row.name)).toEqual(['Elsewhere'])
  })
})

describe('the routes (R15)', () => {
  it('POST /api/org/slaves creates a person with no department and no project', async () => {
    const response = await newPersonRoute(post({ name: 'Atlas' }))
    expect(response.status).toBe(200)
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' }, include: { seats: true, departments: true } })
    expect(person.seats).toEqual([])
    expect(person.departments).toEqual([])
  })

  it('POST /api/persons/:id/assign seats them, and unassign closes the seat', async () => {
    const a = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const params = { params: Promise.resolve({ personId: person.value.personId }) }

    expect((await assignRoute(post({ teamId: a.teamId }), params)).status).toBe(200)
    expect(await prisma.slave.count({ where: { personId: person.value.personId, closedAt: null } })).toBe(1)

    expect((await unassignRoute(post({ teamId: a.teamId, reason: 'done' }), params)).status).toBe(200)
    expect(await prisma.slave.count({ where: { personId: person.value.personId, closedAt: null } })).toBe(0)
  })

  it('PATCH /api/persons/:id/skills grants and revokes', async () => {
    const providerRow = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const pdf = await prisma.skill.create({ data: { providerId: providerRow.id, name: 'pdf', description: 'd' } })
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const params = { params: Promise.resolve({ personId: person.value.personId }) }

    expect((await personSkillsRoute(patch({ grant: [pdf.id] }), params)).status).toBe(200)
    const detail = await readPerson(person.value.personId)
    expect(detail?.skills.map((row) => row.state)).toEqual(['person'])
  })

  it('PATCH /api/org/templates/:id/skills sets the persona defaults', async () => {
    const providerRow = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const pdf = await prisma.skill.create({ data: { providerId: providerRow.id, name: 'pdf', description: 'd' } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    const response = await templateSkillsRoute(patch({ skillIds: [pdf.id] }), {
      params: Promise.resolve({ templateId: template.id }),
    })
    expect(response.status).toBe(200)
    expect(await prisma.templateSkill.count({ where: { templateId: template.id } })).toBe(1)
  })

  it('DELETE /api/persons/:id deletes the PERSON and every seat', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, a.teamId)
    await assignPerson(person.value.personId, b.teamId)

    const response = await deletePersonRoute(new Request('http://localhost/x', { method: 'DELETE' }), {
      params: Promise.resolve({ personId: person.value.personId }),
    })
    expect(response.status).toBe(200)
    expect(await prisma.person.count()).toBe(0)
    expect(await prisma.slave.count()).toBe(0)
  })
})
