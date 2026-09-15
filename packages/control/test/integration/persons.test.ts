import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import {
  assignPerson,
  createPerson,
  deletePerson,
  movePerson,
  personFootprint,
  releasePerson,
  unassignPerson,
} from '../../src/persons.js'
import { truncateAll } from './helpers.js'

async function project(name: string): Promise<{ workspaceId: string; teamId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

beforeEach(async () => {
  await truncateAll()
})

describe('createPerson', () => {
  it('lands a person in the pool with no project and no department', async () => {
    const created = await createPerson({ name: 'Atlas' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = await prisma.person.findUniqueOrThrow({
      where: { id: created.value.personId },
      include: { seats: true, departments: true },
    })
    expect(row.name).toBe('Atlas')
    expect(row.seats).toEqual([])
    expect(row.departments).toEqual([])
    expect(row.releasedAt).toBeNull()
  })

  it('takes its name from the persona when none is given', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    const created = await createPerson({ templateId: template.id })
    expect(created.ok && created.value.name).toBe('Builder')
  })

  it('suffixes a taken name rather than refusing', async () => {
    await createPerson({ name: 'Atlas' })
    const second = await createPerson({ name: 'Atlas' })
    expect(second.ok && second.value.name).toBe('Atlas 2')
  })

  it('refuses an unknown persona', async () => {
    const created = await createPerson({ templateId: 'nope' })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.kind).toBe('template_not_found')
  })

  it('refuses a model with no provider', async () => {
    const created = await createPerson({ name: 'Half', model: 'sonnet' })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.kind).toBe('model_without_provider')
  })
})

describe('assignPerson', () => {
  it('opens a seat and the person is on the project', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, teamId, { role: 'dev', runtimeRoles: ['dev'] })
    expect(seated.ok).toBe(true)
    if (!seated.ok) return
    expect(seated.value.reopened).toBe(false)
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: seated.value.slaveId } })
    expect(seat.teamId).toBe(teamId)
    expect(seat.closedAt).toBeNull()
    expect(seat.runtimeRoles).toEqual(['dev'])
  })

  it('the SAME person can be seated on two projects', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    expect((await assignPerson(person.value.personId, a.teamId)).ok).toBe(true)
    expect((await assignPerson(person.value.personId, b.teamId)).ok).toBe(true)
    const seats = await prisma.slave.findMany({ where: { personId: person.value.personId } })
    expect(seats).toHaveLength(2)
    expect(new Set(seats.map((seat) => seat.teamId))).toEqual(new Set([a.teamId, b.teamId]))
  })

  it('refuses a second seat on the same team', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, teamId)
    const again = await assignPerson(person.value.personId, teamId)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error.kind).toBe('already_assigned')
  })

  it('refuses a released person', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas', lifecycle: 'ephemeral' })
    if (!person.ok) throw new Error('setup')
    await releasePerson(person.value.personId, 'the engagement is over')
    const seated = await assignPerson(person.value.personId, teamId)
    expect(seated.ok).toBe(false)
    if (seated.ok) return
    expect(seated.error.kind).toBe('person_released')
  })

  it('refuses an unknown person and an unknown team, and writes nothing either time', async () => {
    const { teamId } = await project('Alpha')
    expect((await assignPerson('nope', teamId)).ok).toBe(false)
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    expect((await assignPerson(person.value.personId, 'nope')).ok).toBe(false)
    expect(await prisma.slave.count()).toBe(0)
  })
})

describe('unassignPerson', () => {
  it('CLOSES the seat and keeps its runs', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, teamId)
    if (!seated.ok) throw new Error('setup')
    await prisma.slaveRun.create({ data: { slaveId: seated.value.slaveId, status: 'succeeded', kind: 'implementation' } })

    const removed = await unassignPerson(person.value.personId, teamId, { reason: 'done here' })
    expect(removed.ok).toBe(true)
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: seated.value.slaveId }, include: { runs: true } })
    expect(seat.closedAt).not.toBeNull()
    expect(seat.runs).toHaveLength(1)
  })

  it('seating the same person on the same team again REOPENS the closed seat', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const first = await assignPerson(person.value.personId, teamId)
    if (!first.ok) throw new Error('setup')
    await unassignPerson(person.value.personId, teamId, { reason: 'done here' })
    const again = await assignPerson(person.value.personId, teamId)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.slaveId).toBe(first.value.slaveId)
    expect(again.value.reopened).toBe(true)
    expect(await prisma.slave.count({ where: { personId: person.value.personId } })).toBe(1)
  })

  it('refuses while a run is going, and the seat stays open', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, teamId)
    if (!seated.ok) throw new Error('setup')
    await prisma.slaveRun.create({ data: { slaveId: seated.value.slaveId, status: 'working', kind: 'implementation' } })

    const removed = await unassignPerson(person.value.personId, teamId, { reason: 'stop' })
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.error.kind).toBe('run_in_progress')
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: seated.value.slaveId } })
    expect(seat.closedAt).toBeNull()
  })

  it('refuses when there is no open seat to close', async () => {
    const { teamId } = await project('Alpha')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const removed = await unassignPerson(person.value.personId, teamId, { reason: 'nothing' })
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.error.kind).toBe('person_not_seated')
  })
})

describe('movePerson', () => {
  it('closes one seat and opens another in ONE transaction', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const from = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const to = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Design' } })
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, from.id, { role: 'dev', runtimeRoles: ['dev'] })

    const moved = await movePerson(person.value.personId, from.id, to.id)
    expect(moved.ok).toBe(true)
    const seats = await prisma.slave.findMany({ where: { personId: person.value.personId }, orderBy: { teamId: 'asc' } })
    const open = seats.filter((seat) => seat.closedAt === null)
    expect(open).toHaveLength(1)
    expect(open[0]?.teamId).toBe(to.id)
    // The role and the runtime roles travel with the person, not with the department.
    expect(open[0]?.runtimeRoles).toEqual(['dev'])
  })

  it('a refused move leaves the original seat open (the transaction rolled back)', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const from = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, from.id)
    if (!seated.ok) throw new Error('setup')

    const moved = await movePerson(person.value.personId, from.id, 'nope')
    expect(moved.ok).toBe(false)
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: seated.value.slaveId } })
    expect(seat.closedAt).toBeNull()
  })
})

describe('releasePerson', () => {
  it('closes every seat and records the reason', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const person = await createPerson({ name: 'Atlas', lifecycle: 'ephemeral' })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, a.teamId)
    await assignPerson(person.value.personId, b.teamId)

    const released = await releasePerson(person.value.personId, 'the engagement is over')
    expect(released.ok && released.value.seatsClosed).toBe(2)
    const row = await prisma.person.findUniqueOrThrow({
      where: { id: person.value.personId },
      include: { seats: true },
    })
    expect(row.releasedAt).not.toBeNull()
    expect(row.releaseReason).toBe('the engagement is over')
    expect(row.seats.every((seat) => seat.closedAt !== null)).toBe(true)
    expect(row.seats.every((seat) => seat.runtimeRoles.length === 0)).toBe(true)
  })
})

describe('deletePerson', () => {
  it('deletes the person, every seat and every run, and says how many projects went', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const first = await assignPerson(person.value.personId, a.teamId)
    await assignPerson(person.value.personId, b.teamId)
    if (!first.ok) throw new Error('setup')
    await prisma.slaveRun.create({ data: { slaveId: first.value.slaveId, status: 'succeeded', kind: 'implementation' } })
    await prisma.slavePermission.create({ data: { slaveId: first.value.slaveId, kind: 'run_commands', mode: 'allow' } })
    await prisma.memory.create({
      data: {
        type: 'lesson', scope: 'worker', personId: person.value.personId,
        title: 'Prefer pnpm', body: 'because', sourceKind: 'run_output', createdBy: 'slave',
      },
    })

    const footprint = await personFootprint(person.value.personId)
    expect(footprint?.projects).toEqual(['Alpha', 'Beta'])

    const deleted = await deletePerson(person.value.personId)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.seats).toBe(2)
    expect(deleted.value.runs).toBe(1)
    expect(deleted.value.memories).toBe(1)
    expect(deleted.value.projects).toEqual(['Alpha', 'Beta'])
    expect(await prisma.person.count()).toBe(0)
    expect(await prisma.slave.count()).toBe(0)
    expect(await prisma.slaveRun.count()).toBe(0)
    expect(await prisma.slavePermission.count()).toBe(0)
    expect(await prisma.memory.count()).toBe(0)
  })

  it('refuses while a run is in progress on ANY seat, and deletes nothing', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, a.teamId)
    const second = await assignPerson(person.value.personId, b.teamId)
    if (!second.ok) throw new Error('setup')
    await prisma.slaveRun.create({ data: { slaveId: second.value.slaveId, status: 'working', kind: 'implementation' } })

    const deleted = await deletePerson(person.value.personId)
    expect(deleted.ok).toBe(false)
    if (deleted.ok) return
    expect(deleted.error.kind).toBe('run_in_progress')
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.slave.count()).toBe(2)
  })

  it('leaves the persona template alone', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    const person = await createPerson({ templateId: template.id })
    if (!person.ok) throw new Error('setup')
    await deletePerson(person.value.personId)
    expect(await prisma.slaveTemplate.count({ where: { id: template.id } })).toBe(1)
  })
})
