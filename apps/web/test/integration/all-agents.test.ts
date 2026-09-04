import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listAllAgents } from '../../src/server/org.js'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/all-agents-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

describe('listAllAgents', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  // M24 Task 7: `listAllAgents` is `listWorkers()` union `listRoster()`'s workerless members --
  // one row per agent, whether a project has materialized it or not.
  it('unions listWorkers and listRoster into one table: project agents first (by name), then the unmaterialized catalog member last', async (): Promise<void> => {
    const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
    // A second company team, so `templatesByCompany[company.id]` proves it lists every one of the
    // company's teams (M25 Task 6), not just the one a catalog row happens to sit on.
    const companyTeam2 = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
    const template = await prisma.agentTemplate.create({
      data: { name: 'Backend Engineer', role: 'backend', defaultModel: 'sonnet' },
    })

    // Two catalog members on the one company team: one gets materialized into a project agent
    // below, the other never does.
    const materializedMember = await prisma.companyAgent.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
    })
    const catalogOnlyMember = await prisma.companyAgent.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Nova' },
    })
    // The materialized project agent, roster-linked via companyAgentId.
    await prisma.agent.create({
      data: { teamId: fixture.teamId, name: 'Atlas', role: 'backend', companyAgentId: materializedMember.id },
    })
    // A hand-made project agent with no companyAgentId at all -- listWorkers' "no roster filter"
    // rule (server/org.ts, WorkerRow docstring) applies here too. Carries its own `model`
    // override (fix round 1, Important finding 2): a hand-made agent has no roster row for
    // `listAllAgents` to read a chain result off, so its row's `model` must come straight off
    // this `Agent.model` column instead of silently reading back `null`.
    const blair = await prisma.agent.create({
      data: { teamId: fixture.teamId, name: 'Blair', role: 'frontend', model: 'claude-haiku-4' },
    })
    // A live run so `blair`'s row carries a resolved `gate` (M24 final review, Important 3):
    // `listWorkers` reads a worker's gate off its LIVE run's provider, not off any finished one.
    await prisma.agentRun.create({ data: { agentId: blair.id, status: 'working', provider: 'claude_code' } })

    const { rows, departmentsByWorkspace, templatesByCompany } = await listAllAgents()

    expect(rows.map((r) => r.name)).toEqual(['Atlas', 'Blair', 'Nova'])

    const [atlas, blairRow, nova] = rows
    expect(atlas?.agentId).not.toBeNull()
    expect(atlas?.companyAgentId).toBe(materializedMember.id)
    expect(atlas?.projectName).toBe('Checkout Platform')
    // No live run at all -- `gate` is `null`, not a guess at what one might resolve to.
    expect(atlas?.gate).toBeNull()
    // The project row's own team, plus the company it is roster-linked to (M25 Task 6, spec §4.1).
    expect(atlas?.teamId).toBe(fixture.teamId)
    expect(atlas?.companyId).toBe(company.id)
    expect(atlas?.companyTeamId).toBeNull()

    expect(blairRow?.agentId).not.toBeNull()
    expect(blairRow?.companyAgentId).toBeNull()
    expect(blairRow?.projectName).toBe('Checkout Platform')
    expect(blairRow?.model).toBe('claude-haiku-4')
    expect(blairRow?.gate).toBe('all-tools')
    // A hand-made agent has no roster link at all -- its `companyId`/`companyTeamId` stay null.
    expect(blairRow?.teamId).toBe(fixture.teamId)
    expect(blairRow?.companyId).toBeNull()
    expect(blairRow?.companyTeamId).toBeNull()

    expect(nova?.agentId).toBeNull()
    expect(nova?.companyAgentId).toBe(catalogOnlyMember.id)
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
})
