import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { main } from '../../src/cli.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Capability", "Slave", "Person", "Team", "Workspace", "CollaborationHint", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(TRUNCATE)
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
    return chunks.join('')
  } finally {
    process.stdout.write = original
  }
}

beforeEach(async () => {
  await truncateAll()
})

async function persona(name = 'Builder'): Promise<string> {
  const template = await prisma.slaveTemplate.create({ data: { name, role: 'dev' } })
  return template.id
}

async function project(name: string): Promise<{ workspaceId: string; teamId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

describe('person create', () => {
  it('makes a person with no project and no department', async () => {
    const out = await captureStdout(() => main(['person', 'create', '--name', 'Atlas']))
    expect(out).toContain('created')
    expect(out).toContain('Atlas')
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' }, include: { seats: true } })
    expect(person.seats).toEqual([])
  })

  it('takes the persona’s name and seats them when a team is named', async () => {
    const templateId = await persona()
    const { teamId } = await project('Alpha')
    const out = await captureStdout(() => main(['person', 'create', '--template', templateId, '--project', teamId]))
    expect(out).toContain('Builder')
    expect(out).toContain('seated')
    const seats = await prisma.slave.findMany({ include: { person: true } })
    expect(seats).toHaveLength(1)
    expect(seats[0]?.person.name).toBe('Builder')
  })
})

describe('person list', () => {
  it('shows the pool and the seats together, and --pool narrows it', async () => {
    const { teamId } = await project('Alpha')
    await main(['person', 'create', '--name', 'Seated'])
    await main(['person', 'create', '--name', 'Pooled'])
    const seated = await prisma.person.findUniqueOrThrow({ where: { name: 'Seated' } })
    await main(['person', 'assign', '--person', seated.id, '--team', teamId])

    const all = await captureStdout(() => main(['person', 'list']))
    expect(all).toContain('Seated')
    expect(all).toContain('Pooled')
    expect(all).toContain('Alpha')

    const pool = await captureStdout(() => main(['person', 'list', '--pool']))
    expect(pool).toContain('Pooled')
    expect(pool).not.toContain('Seated')
  })
})

describe('person assign / unassign / move', () => {
  it('seats, removes and reopens, saying so each time', async () => {
    const a = await project('Alpha')
    await main(['person', 'create', '--name', 'Atlas'])
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' } })

    expect(await captureStdout(() => main(['person', 'assign', '--person', person.id, '--team', a.teamId]))).toContain(
      'seated',
    )
    expect(
      await captureStdout(() =>
        main(['person', 'unassign', '--person', person.id, '--team', a.teamId, '--reason', 'done']),
      ),
    ).toContain('history')
    expect(await captureStdout(() => main(['person', 'assign', '--person', person.id, '--team', a.teamId]))).toContain(
      'reopened',
    )
    expect(await prisma.slave.count({ where: { personId: person.id } })).toBe(1)
  })
})

describe('person delete', () => {
  it('refuses without --yes and names how many projects would go', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    await main(['person', 'create', '--name', 'Atlas'])
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' } })
    await main(['person', 'assign', '--person', person.id, '--team', a.teamId])
    await main(['person', 'assign', '--person', person.id, '--team', b.teamId])

    await expect(main(['person', 'delete', '--person', person.id])).rejects.toThrow(/2 projects/)
    expect(await prisma.person.count()).toBe(1)

    const out = await captureStdout(() => main(['person', 'delete', '--person', person.id, '--yes']))
    expect(out).toContain('Alpha')
    expect(out).toContain('Beta')
    expect(await prisma.person.count()).toBe(0)
  })
})

describe('the existing verbs, rebound', () => {
  it('add-slave creates a person and puts them in the department, with no project', async () => {
    const templateId = await persona()
    const company = await prisma.company.create({ data: { name: 'Acme' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })

    await main(['add-slave', '--team', companyTeam.id, '--template', templateId, '--name', 'Atlas'])
    const person = await prisma.person.findUniqueOrThrow({
      where: { name: 'Atlas' },
      include: { departments: true, seats: true },
    })
    expect(person.departments).toHaveLength(1)
    expect(person.seats).toEqual([])
  })

  it('assign-company binds the SAME person to a second project rather than copying them', async () => {
    const templateId = await persona()
    const company = await prisma.company.create({ data: { name: 'Acme' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    await main(['add-slave', '--team', companyTeam.id, '--template', templateId, '--name', 'Atlas'])
    const a = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const b = await prisma.workspace.create({
      data: { name: 'Beta', repoPath: '/tmp/b', verifyCommands: ['true'], setupCommands: [] },
    })

    await main(['assign-company', '--workspace', a.id, '--company', company.id])
    await main(['assign-company', '--workspace', b.id, '--company', company.id])

    expect(await prisma.person.count()).toBe(1)
    const seats = await prisma.slave.findMany({ include: { team: true } })
    expect(seats).toHaveLength(2)
    expect(new Set(seats.map((seat) => seat.team.workspaceId))).toEqual(new Set([a.id, b.id]))
  })

  it('delete-slave deletes the PERSON, and says how many other projects went with them', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    await main(['person', 'create', '--name', 'Atlas'])
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' } })
    const first = await main(['person', 'assign', '--person', person.id, '--team', a.teamId])
    void first
    await main(['person', 'assign', '--person', person.id, '--team', b.teamId])
    const seat = await prisma.slave.findFirstOrThrow({ where: { personId: person.id, teamId: a.teamId } })

    await expect(main(['delete-slave', '--slave', seat.id])).rejects.toThrow(/2 projects/)
    await main(['delete-slave', '--slave', seat.id, '--yes'])
    expect(await prisma.person.count()).toBe(0)
    expect(await prisma.slave.count()).toBe(0)
  })

  it('set-capabilities takes --slave and says it resolved it to the person', async () => {
    const { teamId } = await project('Alpha')
    await main(['person', 'create', '--name', 'Atlas'])
    const person = await prisma.person.findUniqueOrThrow({ where: { name: 'Atlas' } })
    await main(['person', 'assign', '--person', person.id, '--team', teamId])
    const seat = await prisma.slave.findFirstOrThrow({ where: { personId: person.id } })
    await prisma.capability.create({ data: { key: 'backend', label: 'Backend', domain: 'backend', role: 'dev' } })

    const out = await captureStdout(() => main(['set-capabilities', '--slave', seat.id, '--capabilities', 'backend']))
    expect(out).toMatch(/a capability belongs to the slave, not the seat/i)
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
    expect(after.capabilities).toEqual(['backend'])
  })
})
