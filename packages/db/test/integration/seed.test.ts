import { afterAll, describe, expect, it } from 'vitest'
import { CHECKOUT_PLATFORM_COMPANY_NAME } from '../../src/checkout-platform.js'
import { prisma } from '../../src/client.js'
import { TASK_STATUSES } from '../../src/enums.js'
import { DEMO_TRADING_COMPANY_NAME, seed } from '../../src/seed.js'

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

    // Sorted in JS with a plain comparator rather than by the database: the Checkout Platform
    // templates below are named after roles that are not all capitalised the same way
    // (`manager`, `reviewer`, `SEO`, `Security`), and where two names differ only in case a
    // Postgres `ORDER BY name` answers by the server's collation -- which is not this repo's to
    // pin. The rows asserted are the same either way; only their order here is made deterministic.
    const templates = await prisma.slaveTemplate.findMany()
    const byName = [...templates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    expect(byName.map((t) => ({ name: t.name, role: t.role, defaultModel: t.defaultModel }))).toEqual([
      { name: 'Backend Developer', role: 'backend', defaultModel: null },
      // M31b final fix wave: one template per distinct role on the Checkout Platform catalog
      // company, since `rosterOf` reads a catalog slave's role off its template.
      { name: 'Checkout Backend', role: 'Backend', defaultModel: null },
      { name: 'Checkout Business Analyst', role: 'Business Analyst', defaultModel: null },
      { name: 'Checkout DevOps', role: 'DevOps', defaultModel: null },
      { name: 'Checkout Frontend', role: 'Frontend', defaultModel: null },
      { name: 'Checkout QA', role: 'QA', defaultModel: null },
      { name: 'Checkout SEO', role: 'SEO', defaultModel: null },
      { name: 'Checkout Security', role: 'Security', defaultModel: null },
      { name: 'Checkout manager', role: 'manager', defaultModel: null },
      { name: 'Checkout reviewer', role: 'reviewer', defaultModel: null },
      { name: 'Engineering Manager', role: 'manager', defaultModel: null },
      { name: 'Frontend Developer', role: 'frontend', defaultModel: null },
      // The canonical shared-template example: two roles (this one and Backend Developer) point
      // at the same `role`, proving templates key on name, not role.
      { name: 'Java Developer', role: 'backend', defaultModel: null },
      { name: 'QA Reviewer', role: 'reviewer', defaultModel: null },
      // M29: the demo trading company's one generic template.
      { name: 'Trade Clerk', role: 'clerk', defaultModel: null },
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

  it('seeds Demo Trading Co. with four departments, one clerk each (M29)', async () => {
    await seed()

    const company = await prisma.company.findUniqueOrThrow({ where: { name: DEMO_TRADING_COMPANY_NAME } })

    const companyTeams = await prisma.companyTeam.findMany({ where: { companyId: company.id }, orderBy: { name: 'asc' } })
    expect(companyTeams.map((t) => t.name)).toEqual(['Finance', 'Operations', 'Purchasing', 'Sales'])

    const roster = await prisma.companySlave.findMany({
      where: { companyTeam: { companyId: company.id } },
      include: { template: true },
      orderBy: { name: 'asc' },
    })
    expect(roster.map((member) => ({ name: member.name, template: member.template.name }))).toEqual([
      { name: 'Fin', template: 'Trade Clerk' },
      { name: 'Olga', template: 'Trade Clerk' },
      { name: 'Pete', template: 'Trade Clerk' },
      { name: 'Sonia', template: 'Trade Clerk' },
    ])
  })

  it('seeds Checkout Platform as a catalog company the software sector can be run on (M31b)', async () => {
    await seed()

    const company = await prisma.company.findUniqueOrThrow({ where: { name: CHECKOUT_PLATFORM_COMPANY_NAME } })

    const companyTeams = await prisma.companyTeam.findMany({ where: { companyId: company.id }, orderBy: { name: 'asc' } })
    expect(companyTeams.map((t) => t.name)).toEqual(['Engineering', 'Management', 'Marketing', 'Product', 'Security'])

    // Department, name and CATALOG role (off the template) -- exactly what control's `rosterOf`
    // reads, in the order it reads it: teams then slaves, both name-ascending.
    const roster = await prisma.companyTeam.findMany({
      where: { companyId: company.id },
      orderBy: { name: 'asc' },
      select: { name: true, slaves: { orderBy: { name: 'asc' }, select: { name: true, template: { select: { role: true } } } } },
    })
    expect(roster.flatMap((team) => team.slaves.map((slave) => `${team.name}/${slave.name}/${slave.template.role}`))).toEqual([
      'Engineering/Alex/Backend',
      'Engineering/Daniel/DevOps',
      'Engineering/Emma/Frontend',
      'Engineering/Maya/QA',
      'Engineering/Riley/reviewer',
      'Management/Atlas/manager',
      'Marketing/Oliver/SEO',
      'Product/John/Business Analyst',
      'Security/Sarah/Security',
    ])
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
