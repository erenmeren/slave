import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { TASK_STATUSES } from '../../src/enums.js'
import { seed } from '../../src/seed.js'

describe('seed data', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('creates the Atlas organisation', async () => {
    await seed()

    const teams = await prisma.team.findMany({ include: { slaves: true }, orderBy: { name: 'asc' } })
    expect(teams.map((t) => t.name)).toEqual(['Engineering', 'Management', 'Marketing', 'Product', 'Security'])

    const slaves = await prisma.slave.findMany({ orderBy: { name: 'asc' } })
    expect(slaves.map((a) => a.name)).toEqual([
      'Alex',
      'Atlas',
      'Daniel',
      'Emma',
      'John',
      'Maya',
      'Oliver',
      'Riley',
      'Sarah',
    ])

    // Lowercase, matching the M8b planning dispatch's exact-match `role === 'manager'` -- the
    // same convention `role === 'reviewer'` (M8a) already follows.
    const atlas = slaves.find((slave) => slave.name === 'Atlas')
    expect(atlas?.role).toBe('manager')
  })

  it('seeds the reusable template catalog', async () => {
    await seed()

    const templates = await prisma.slaveTemplate.findMany({ orderBy: { name: 'asc' } })
    expect(templates.map((t) => ({ name: t.name, role: t.role, defaultModel: t.defaultModel }))).toEqual([
      { name: 'Backend Developer', role: 'backend', defaultModel: null },
      { name: 'Engineering Manager', role: 'manager', defaultModel: null },
      { name: 'Frontend Developer', role: 'frontend', defaultModel: null },
      // The canonical shared-template example: two roles (this one and Backend Developer) point
      // at the same `role`, proving templates key on name, not role.
      { name: 'Java Developer', role: 'backend', defaultModel: null },
      { name: 'QA Reviewer', role: 'reviewer', defaultModel: null },
    ])
  })

  it('seeds Atlas Software with an Engineering roster mirroring the seeded crew', async () => {
    await seed()

    const company = await prisma.company.findUniqueOrThrow({ where: { name: 'Atlas Software' } })

    const companyTeams = await prisma.companyTeam.findMany({ where: { companyId: company.id } })
    expect(companyTeams.map((t) => t.name)).toEqual(['Engineering'])

    const companyTeam = await prisma.companyTeam.findFirstOrThrow({ where: { companyId: company.id } })
    const roster = await prisma.companySlave.findMany({
      where: { companyTeamId: companyTeam.id },
      include: { template: true },
      orderBy: { name: 'asc' },
    })
    expect(roster.map((member) => ({ name: member.name, template: member.template.name }))).toEqual([
      { name: 'Alex', template: 'Backend Developer' },
      { name: 'Atlas', template: 'Engineering Manager' },
      { name: 'Emma', template: 'Frontend Developer' },
      { name: 'Riley', template: 'QA Reviewer' },
    ])

    // The legacy seeded workspace is untouched by the company catalog (spec Decision 7): its
    // slaves keep their own Backend/Frontend/DevOps/QA roles, not the template names above, and
    // the workspace itself is never assigned to Atlas Software.
    const workspace = await prisma.workspace.findFirstOrThrow()
    expect(workspace.companyId).toBeNull()
  })

  it('creates one task in every task status', async () => {
    await seed()

    const tasks = await prisma.task.findMany()
    expect(tasks).toHaveLength(TASK_STATUSES.length)
    expect(tasks.map((t) => t.status).sort()).toEqual([...TASK_STATUSES].sort())
  })

  it('copies maxAttempts from the workspace onto every task', async () => {
    await seed()

    const workspace = await prisma.workspace.findFirstOrThrow()
    const tasks = await prisma.task.findMany({ select: { maxAttempts: true } })

    expect(tasks.every((t) => t.maxAttempts === workspace.maxAttempts)).toBe(true)
  })

  it('is idempotent — running it twice leaves the same row counts', async () => {
    await seed()
    const first = {
      slaves: await prisma.slave.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
      templates: await prisma.slaveTemplate.count(),
      companies: await prisma.company.count(),
      companyTeams: await prisma.companyTeam.count(),
      companySlaves: await prisma.companySlave.count(),
    }

    await seed()
    const second = {
      slaves: await prisma.slave.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
      templates: await prisma.slaveTemplate.count(),
      companies: await prisma.company.count(),
      companyTeams: await prisma.companyTeam.count(),
      companySlaves: await prisma.companySlave.count(),
    }

    expect(second).toEqual(first)
  })
})
