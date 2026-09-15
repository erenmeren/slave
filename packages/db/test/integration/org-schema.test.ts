import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedChain(): Promise<{
  templateId: string
  templateName: string
  companyId: string
  companyName: string
  companyTeamId: string
  companyTeamName: string
  personId: string
  workerId: string
}> {
  const template = await prisma.slaveTemplate.create({
    data: { name: 'Java Developer', role: 'backend', defaultModel: 'claude-sonnet-5' },
  })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
  // M58 R5: a department holds PEOPLE. The person exists first and the membership binds them to
  // the department; nothing is copied.
  const person = await prisma.person.create({
    data: { name: 'Atlas', templateId: template.id, lifecycle: 'permanent' },
  })
  await prisma.companyTeamMember.create({ data: { companyTeamId: companyTeam.id, personId: person.id } })

  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const worker = await prisma.slave.create({
    data: { teamId: team.id, personId: person.id, role: 'backend' },
  })

  return {
    templateId: template.id,
    templateName: template.name,
    companyId: company.id,
    companyName: company.name,
    companyTeamId: companyTeam.id,
    companyTeamName: companyTeam.name,
    personId: person.id,
    workerId: worker.id,
  }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Slave", "Team", "Workspace", "CompanyTeamMember", "Person", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('the organization schema', () => {
  it('links template -> person -> department -> seat and reads the chain back', async () => {
    const chain = await seedChain()

    const found = await prisma.person.findUniqueOrThrow({
      where: { id: chain.personId },
      include: {
        template: true,
        departments: { include: { companyTeam: { include: { company: true } } } },
        seats: true,
      },
    })

    expect(found.name).toBe('Atlas')
    expect(found.template?.name).toBe(chain.templateName)
    expect(found.template?.role).toBe('backend')
    expect(found.template?.description).toBe('')
    expect(found.departments.map((member) => member.companyTeam.name)).toEqual([chain.companyTeamName])
    expect(found.departments.map((member) => member.companyTeam.company.name)).toEqual([chain.companyName])
    expect(found.seats.map((seat) => seat.id)).toEqual([chain.workerId])
  })

  it('rejects a duplicate template name', async () => {
    await prisma.slaveTemplate.create({ data: { name: 'Java Developer', role: 'backend' } })

    await expect(prisma.slaveTemplate.create({ data: { name: 'Java Developer', role: 'frontend' } })).rejects.toThrow()
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

  // M58 R1: a name is unique across the INSTALLATION now, not per department -- and the second
  // department gets the SAME person rather than a second row with the same name.
  it('rejects a duplicate person name anywhere, and lets one person sit in two departments', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend' } })
    const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    const person = await prisma.person.create({ data: { name: 'Atlas', templateId: template.id } })
    await prisma.companyTeamMember.create({ data: { companyTeamId: team.id, personId: person.id } })

    await expect(prisma.person.create({ data: { name: 'Atlas', templateId: template.id } })).rejects.toThrow()

    const otherTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Marketing' } })
    await expect(
      prisma.companyTeamMember.create({ data: { companyTeamId: otherTeam.id, personId: person.id } }),
    ).resolves.toMatchObject({ personId: person.id })
  })

  it('cascades company deletion to its departments and memberships, and leaves the template, the person and the seat intact', async () => {
    const chain = await seedChain()

    await prisma.company.delete({ where: { id: chain.companyId } })

    expect(await prisma.companyTeam.count()).toBe(0)
    expect(await prisma.companyTeamMember.count()).toBe(0)
    expect(await prisma.slaveTemplate.findUnique({ where: { id: chain.templateId } })).not.toBeNull()

    // M58 R5: losing a department is losing a MEMBERSHIP. The person keeps working, and the seat
    // with its run history is untouched -- the rule `Slave.companySlaveId`'s SetNull used to carry.
    expect(await prisma.person.findUnique({ where: { id: chain.personId } })).not.toBeNull()
    const survivor = await prisma.slave.findUniqueOrThrow({ where: { id: chain.workerId } })
    expect(survivor.personId).toBe(chain.personId)
  })

  it('adds nullable model/company columns to Slave, Workspace and Checkpoint without breaking existing rows', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'w', repoPath: '/tmp/w', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
    })
    expect(workspace.companyId).toBeNull()

    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await prisma.person.create({ data: { name: 'Alex' } })
    const slave = await prisma.slave.create({
      data: { teamId: team.id, personId: person.id, role: 'backend', model: 'claude-opus-4' },
    })
    expect(slave.model).toBe('claude-opus-4')
    expect(slave.closedAt).toBeNull()

    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: 't', description: 'd', maxAttempts: workspace.maxAttempts },
    })
    const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id } })
    const checkpoint = await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's',
        worktreePath: '/tmp/wt',
        pauseFlagPath: '/tmp/wt/.slaveofai-pause',
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

  it('links a project Team to its roster CompanyTeam by id, and SetNulls that link on company deletion while the team row survives', async () => {
    const chain = await seedChain()

    const team = await prisma.team.findUniqueOrThrow({ where: { id: (await prisma.slave.findUniqueOrThrow({ where: { id: chain.workerId } })).teamId } })
    await prisma.team.update({ where: { id: team.id }, data: { companyTeamId: chain.companyTeamId } })
    const linked = await prisma.team.findUniqueOrThrow({ where: { id: team.id } })
    expect(linked.companyTeamId).toBe(chain.companyTeamId)

    await prisma.company.delete({ where: { id: chain.companyId } })

    const survivor = await prisma.team.findUniqueOrThrow({ where: { id: team.id } })
    expect(survivor.companyTeamId).toBeNull()
  })
})
