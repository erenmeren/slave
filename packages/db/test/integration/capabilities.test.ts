import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedSlave(): Promise<{ workspaceId: string; slaveId: string }> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

describe('slave capabilities', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SlaveSkill", "Skill", "SkillProvider", "SlavePermission", "ProviderConfiguration", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('rejects two permissions for the same slave and tool', async () => {
    const { slaveId } = await seedSlave()
    await prisma.slavePermission.create({ data: { slaveId, tool: 'Bash', mode: 'allow' } })

    await expect(
      prisma.slavePermission.create({ data: { slaveId, tool: 'Bash', mode: 'deny' } }),
    ).rejects.toThrow()
  })

  it('links a slave to skills through the join table', async () => {
    const { slaveId } = await seedSlave()
    const provider = await prisma.skillProvider.create({ data: { name: 'superpowers' } })
    const skill = await prisma.skill.create({
      data: { providerId: provider.id, name: 'test-driven-development', description: 'TDD' },
    })
    await prisma.slaveSkill.create({ data: { slaveId, skillId: skill.id } })

    const found = await prisma.slave.findUniqueOrThrow({
      where: { id: slaveId },
      include: { skills: { include: { skill: true } } },
    })

    expect(found.skills.map((link) => link.skill.name)).toEqual(['test-driven-development'])
  })

  it('allows one configuration per provider kind per workspace', async () => {
    const { workspaceId } = await seedSlave()
    await prisma.providerConfiguration.create({
      data: { workspaceId, kind: 'claude_code', settings: { permissionMode: 'bypassPermissions' } },
    })

    await expect(
      prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } }),
    ).rejects.toThrow()
  })
})
