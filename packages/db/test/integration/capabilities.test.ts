import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedAgent(): Promise<{ workspaceId: string; agentId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('agent capabilities', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "ProviderConfiguration", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('rejects two permissions for the same agent and tool', async () => {
    const { agentId } = await seedAgent()
    await prisma.agentPermission.create({ data: { agentId, tool: 'Bash', mode: 'allow' } })

    await expect(
      prisma.agentPermission.create({ data: { agentId, tool: 'Bash', mode: 'deny' } }),
    ).rejects.toThrow()
  })

  it('links an agent to skills through the join table', async () => {
    const { agentId } = await seedAgent()
    const provider = await prisma.skillProvider.create({ data: { name: 'superpowers' } })
    const skill = await prisma.skill.create({
      data: { providerId: provider.id, name: 'test-driven-development', description: 'TDD' },
    })
    await prisma.agentSkill.create({ data: { agentId, skillId: skill.id } })

    const found = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { skills: { include: { skill: true } } },
    })

    expect(found.skills.map((link) => link.skill.name)).toEqual(['test-driven-development'])
  })

  it('allows one configuration per provider kind per workspace', async () => {
    const { workspaceId } = await seedAgent()
    await prisma.providerConfiguration.create({
      data: { workspaceId, kind: 'claude_code', settings: { permissionMode: 'bypassPermissions' } },
    })

    await expect(
      prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } }),
    ).rejects.toThrow()
  })
})
