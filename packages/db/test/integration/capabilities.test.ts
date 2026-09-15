import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedSlave(): Promise<{ workspaceId: string; slaveId: string; personId: string }> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Alex' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, personId: person.id, role: 'Backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id, personId: person.id }
}

describe('slave capabilities', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "SlavePermission", "ProviderConfiguration", "Slave", "Team", "Person", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  // M52 R1: `@@unique([slaveId, kind])` replaced `@@unique([slaveId, tool])` -- the same invariant
  // one column over, now over a closed enum rather than free text.
  it('rejects two permissions for the same slave and kind', async () => {
    const { slaveId } = await seedSlave()
    await prisma.slavePermission.create({ data: { slaveId, kind: 'run_commands', mode: 'allow' } })

    await expect(
      prisma.slavePermission.create({ data: { slaveId, kind: 'run_commands', mode: 'deny' } }),
    ).rejects.toThrow()
  })

  // M58 R3: a skill belongs to the PERSON, as a grant or a revoke over the persona's defaults --
  // and the same pair can never be both, which is what the composite primary key buys.
  it('links a person to skills through the grant table, and a persona to its defaults', async () => {
    const { personId } = await seedSlave()
    const provider = await prisma.skillProvider.create({ data: { name: 'superpowers' } })
    const skill = await prisma.skill.create({
      data: { providerId: provider.id, name: 'test-driven-development', description: 'TDD' },
    })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend' } })
    await prisma.personSkill.create({ data: { personId, skillId: skill.id, mode: 'granted' } })
    await prisma.templateSkill.create({ data: { templateId: template.id, skillId: skill.id } })

    const found = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      include: { skills: { include: { skill: true } } },
    })
    expect(found.skills.map((link) => ({ name: link.skill.name, mode: link.mode }))).toEqual([
      { name: 'test-driven-development', mode: 'granted' },
    ])

    await expect(
      prisma.personSkill.create({ data: { personId, skillId: skill.id, mode: 'revoked' } }),
    ).rejects.toThrow()

    const persona = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { defaultSkills: { include: { skill: true } } },
    })
    expect(persona.defaultSkills.map((link) => link.skill.name)).toEqual(['test-driven-development'])
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
