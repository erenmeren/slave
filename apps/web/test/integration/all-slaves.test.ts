import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listAllSlaves } from '../../src/server/org.js'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/all-slaves-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

describe('listAllSlaves', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  // M24 Task 7: `listAllSlaves` is `listWorkers()` union `listRoster()`'s workerless members --
  // one row per slave, whether a project has materialized it or not.
  it('unions listWorkers and listRoster into one table: project slaves first (by name), then the unmaterialized catalog member last', async (): Promise<void> => {
    const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
    // A second company team, so `templatesByCompany[company.id]` proves it lists every one of the
    // company's teams (M25 Task 6), not just the one a catalog row happens to sit on.
    const companyTeam2 = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Backend Engineer', role: 'backend', defaultModel: 'sonnet' },
    })

    // Two catalog members on the one company team: one gets materialized into a project slave
    // below, the other never does.
    const materializedMember = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
    })
    const catalogOnlyMember = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Nova' },
    })
    // The materialized project slave, roster-linked via companySlaveId.
    await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Atlas', role: 'backend', companySlaveId: materializedMember.id },
    })
    // A hand-made project slave with no companySlaveId at all -- listWorkers' "no roster filter"
    // rule (server/org.ts, WorkerRow docstring) applies here too. Carries its own `model`
    // override (fix round 1, Important finding 2): a hand-made slave has no roster row for
    // `listAllSlaves` to read a chain result off, so its row's `model` must come straight off
    // this `Slave.model` column instead of silently reading back `null`.
    const blair = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Blair', role: 'frontend', model: 'claude-haiku-4' },
    })
    // A live run so `blair`'s row carries a resolved `gate` (M24 final review, Important 3):
    // `listWorkers` reads a worker's gate off its LIVE run's provider, not off any finished one.
    await prisma.slaveRun.create({ data: { slaveId: blair.id, status: 'working', provider: 'claude_code' } })

    const { rows, departmentsByWorkspace, templatesByCompany } = await listAllSlaves()

    expect(rows.map((r) => r.name)).toEqual(['Atlas', 'Blair', 'Nova'])

    const [atlas, blairRow, nova] = rows
    expect(atlas?.slaveId).not.toBeNull()
    expect(atlas?.companySlaveId).toBe(materializedMember.id)
    expect(atlas?.projectName).toBe('Checkout Platform')
    // No live run at all -- `gate` is `null`, not a guess at what one might resolve to.
    expect(atlas?.gate).toBeNull()
    // The project row's own team, plus the company it is roster-linked to (M25 Task 6, spec §4.1).
    expect(atlas?.teamId).toBe(fixture.teamId)
    expect(atlas?.companyId).toBe(company.id)
    expect(atlas?.companyTeamId).toBeNull()

    expect(blairRow?.slaveId).not.toBeNull()
    expect(blairRow?.companySlaveId).toBeNull()
    expect(blairRow?.projectName).toBe('Checkout Platform')
    expect(blairRow?.model).toBe('claude-haiku-4')
    expect(blairRow?.gate).toBe('all-tools')
    // M27 §7: `runCount` rides the same grouped query `costUsd`/`unmeasuredRuns` already read off
    // -- one seeded run, no second round trip.
    expect(blairRow?.runCount).toBe(1)
    // A hand-made slave has no roster link at all -- its `companyId`/`companyTeamId` stay null.
    expect(blairRow?.teamId).toBe(fixture.teamId)
    expect(blairRow?.companyId).toBeNull()
    expect(blairRow?.companyTeamId).toBeNull()

    expect(nova?.slaveId).toBeNull()
    expect(nova?.companySlaveId).toBe(catalogOnlyMember.id)
    expect(nova?.projectName).toBeNull()
    expect(nova?.workspaceId).toBeNull()
    expect(nova?.status).toBe('idle')
    // No template `provider` set -- the catalog chain resolves to no effective provider at all.
    expect(nova?.gate).toBeNull()
    // A catalog row has no project team, but does carry the company/company-team it lives on.
    expect(nova?.teamId).toBeNull()
    expect(nova?.companyId).toBe(company.id)
    expect(nova?.companyTeamId).toBe(companyTeam.id)

    // The page's own option lists: the seeded project's departments by workspace, and the
    // seeded company's templates (every one of its teams, not just the one a catalog row sits
    // on) -- one query each, read straight off the page object rather than re-derived per row.
    expect(departmentsByWorkspace[fixture.workspaceId]?.map((d) => d.name)).toEqual(['Engineering'])
    expect(templatesByCompany[company.id]?.map((t) => t.name)).toEqual(['Design', 'Eng'])
  })

  // M27 §3.3: the Slaves page hides an archived project's rows by default, the same rule every
  // other list read follows.
  it('hides an archived project\'s rows unless includeArchived is set', async (): Promise<void> => {
    await prisma.slave.create({ data: { teamId: fixture.teamId, name: 'Blair', role: 'frontend' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    expect((await listAllSlaves()).rows).toEqual([])

    const archived = await listAllSlaves({ includeArchived: true })
    expect(archived.rows.map((r) => r.name)).toEqual(['Blair'])
  })

  // Fix round 1, Important finding 1: a roster-linked slave whose ONLY project is archived used
  // to vanish entirely -- filtered out of `listWorkers`' project rows, and never falling into the
  // catalog branch because `member.workers.length !== 0`. It must fall back to a catalog row
  // instead, carrying `catalog-slave-delete` the way an unmaterialized member does.
  it('falls back to the catalog row when every project a roster member was materialized into is archived', async (): Promise<void> => {
    const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
    const member = await prisma.companySlave.create({ data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' } })
    await prisma.slave.create({ data: { teamId: fixture.teamId, name: 'Atlas', role: 'backend', companySlaveId: member.id } })

    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    const { rows } = await listAllSlaves()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slaveId: null, companySlaveId: member.id, name: 'Atlas', runCount: 0 })
  })
})
