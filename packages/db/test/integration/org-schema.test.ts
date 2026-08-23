import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedChain(): Promise<{
  templateId: string
  templateName: string
  companyId: string
  companyName: string
  companyTeamId: string
  companyTeamName: string
  companyAgentId: string
  workerId: string
}> {
  const template = await prisma.agentTemplate.create({
    data: { name: 'Java Developer', role: 'backend', defaultModel: 'claude-sonnet-5' },
  })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
  const companyAgent = await prisma.companyAgent.create({
    data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
  })

  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const worker = await prisma.agent.create({
    data: { teamId: team.id, name: 'Atlas', role: 'backend', companyAgentId: companyAgent.id },
  })

  return {
    templateId: template.id,
    templateName: template.name,
    companyId: company.id,
    companyName: company.name,
    companyTeamId: companyTeam.id,
    companyTeamName: companyTeam.name,
    companyAgentId: companyAgent.id,
    workerId: worker.id,
  }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('the organization schema', () => {
  it('links template -> company -> team -> roster agent -> worker and reads the chain back', async () => {
    const chain = await seedChain()

    const found = await prisma.companyAgent.findUniqueOrThrow({
      where: { id: chain.companyAgentId },
      include: {
        template: true,
        companyTeam: { include: { company: true } },
        workers: true,
      },
    })

    expect(found.name).toBe('Atlas')
    expect(found.template.name).toBe(chain.templateName)
    expect(found.template.role).toBe('backend')
    expect(found.template.description).toBe('')
    expect(found.companyTeam.name).toBe(chain.companyTeamName)
    expect(found.companyTeam.company.name).toBe(chain.companyName)
    expect(found.workers.map((w) => w.id)).toEqual([chain.workerId])
  })

  it('rejects a duplicate template name', async () => {
    await prisma.agentTemplate.create({ data: { name: 'Java Developer', role: 'backend' } })

    await expect(prisma.agentTemplate.create({ data: { name: 'Java Developer', role: 'frontend' } })).rejects.toThrow()
  })

  it('rejects a duplicate company name', async () => {
    await prisma.company.create({ data: { name: 'Atlas Software' } })

    await expect(prisma.company.create({ data: { name: 'Atlas Software' } })).rejects.toThrow()
  })

  it('rejects a duplicate team name within one company but allows the same name in another company', async () => {
    const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
    await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })

    await expect(prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })).rejects.toThrow()

    const otherCompany = await prisma.company.create({ data: { name: 'Other Co' } })
    await expect(
      prisma.companyTeam.create({ data: { companyId: otherCompany.id, name: 'Engineering' } }),
    ).resolves.toMatchObject({ name: 'Engineering' })
  })

  it('rejects a duplicate roster member name within one team but allows the same name in another team', async () => {
    const template = await prisma.agentTemplate.create({ data: { name: 'Backend Developer', role: 'backend' } })
    const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    await prisma.companyAgent.create({ data: { companyTeamId: team.id, templateId: template.id, name: 'Atlas' } })

    await expect(
      prisma.companyAgent.create({ data: { companyTeamId: team.id, templateId: template.id, name: 'Atlas' } }),
    ).rejects.toThrow()

    const otherTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Marketing' } })
    await expect(
      prisma.companyAgent.create({ data: { companyTeamId: otherTeam.id, templateId: template.id, name: 'Atlas' } }),
    ).resolves.toMatchObject({ name: 'Atlas' })
  })

  it('cascades company deletion to its teams and roster, leaves the template intact, and nulls the worker link', async () => {
    const chain = await seedChain()

    await prisma.company.delete({ where: { id: chain.companyId } })

    expect(await prisma.companyTeam.count()).toBe(0)
    expect(await prisma.companyAgent.count()).toBe(0)
    expect(await prisma.agentTemplate.findUnique({ where: { id: chain.templateId } })).not.toBeNull()

    // The worker with run history must survive its roster row's deletion -- Agent.companyAgent is
    // onDelete: SetNull, never Cascade.
    const survivor = await prisma.agent.findUniqueOrThrow({ where: { id: chain.workerId } })
    expect(survivor.companyAgentId).toBeNull()
  })

  it('adds nullable model/company columns to Agent, Workspace and Checkpoint without breaking existing rows', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'w', repoPath: '/tmp/w', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
    })
    expect(workspace.companyId).toBeNull()

    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const agent = await prisma.agent.create({
      data: { teamId: team.id, name: 'Alex', role: 'backend', model: 'claude-opus-4' },
    })
    expect(agent.model).toBe('claude-opus-4')
    expect(agent.companyAgentId).toBeNull()

    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: 't', description: 'd', maxAttempts: workspace.maxAttempts },
    })
    const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId: agent.id } })
    const checkpoint = await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's',
        worktreePath: '/tmp/wt',
        pauseFlagPath: '/tmp/wt/.aiteamos-pause',
        headCommit: 'abc123',
        settingsPath: '/tmp/wt/.claude/settings.json',
        hookPath: '/tmp/wt/.claude/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@example.com',
        model: 'claude-sonnet-5',
      },
    })
    expect(checkpoint.model).toBe('claude-sonnet-5')
  })
})
