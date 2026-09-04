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
    await prisma.agent.create({
      data: { teamId: fixture.teamId, name: 'Blair', role: 'frontend', model: 'claude-haiku-4' },
    })

    const rows = await listAllAgents()

    expect(rows.map((r) => r.name)).toEqual(['Atlas', 'Blair', 'Nova'])

    const [atlas, blair, nova] = rows
    expect(atlas?.agentId).not.toBeNull()
    expect(atlas?.companyAgentId).toBe(materializedMember.id)
    expect(atlas?.projectName).toBe('Checkout Platform')

    expect(blair?.agentId).not.toBeNull()
    expect(blair?.companyAgentId).toBeNull()
    expect(blair?.projectName).toBe('Checkout Platform')
    expect(blair?.model).toBe('claude-haiku-4')

    expect(nova?.agentId).toBeNull()
    expect(nova?.companyAgentId).toBe(catalogOnlyMember.id)
    expect(nova?.projectName).toBeNull()
    expect(nova?.workspaceId).toBeNull()
    expect(nova?.status).toBe('idle')
  })
})
