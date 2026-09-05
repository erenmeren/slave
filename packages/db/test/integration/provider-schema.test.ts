import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedWorkspaceWithSlave(): Promise<{ workspaceId: string; slaveId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "SlaveRun", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('the provider pair columns', () => {
  it('accepts a null cost — an unmeasured run is not a free one', async () => {
    const { slaveId } = await seedWorkspaceWithSlave()
    const run = await prisma.slaveRun.create({
      // The brief's illustrative test used 'running', which is not a RunStatus member (the real
      // enum has 'starting'/'working'/... -- see schema.prisma). 'working' is the closest match
      // to what the brief meant: an in-flight run.
      data: { slaveId, kind: 'implementation', status: 'working', costUsd: null },
    })
    expect(run.costUsd).toBeNull()
    expect(run.provider).toBeNull()
  })

  it('keeps every pre-M12 row readable with a null provider', async () => {
    const { slaveId } = await seedWorkspaceWithSlave()
    const slave = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(slave.provider).toBeNull()
  })

  it('stamps provider on Slave, SlaveTemplate, CompanySlave, SlaveRun and Checkpoint', async () => {
    const { slaveId } = await seedWorkspaceWithSlave()

    const template = await prisma.slaveTemplate.create({
      data: { name: 'Backend Developer', role: 'backend', provider: 'claude_code' },
    })
    expect(template.provider).toBe('claude_code')

    const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    const companySlave = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', provider: 'cursor' },
    })
    expect(companySlave.provider).toBe('cursor')

    const stampedSlave = await prisma.slave.update({ where: { id: slaveId }, data: { provider: 'claude_code' } })
    expect(stampedSlave.provider).toBe('claude_code')

    const run = await prisma.slaveRun.create({ data: { slaveId, provider: 'cursor' } })
    expect(run.provider).toBe('cursor')

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
        provider: 'cursor',
      },
    })
    expect(checkpoint.provider).toBe('cursor')
  })

  it('drops the costUsd default so an insert with no explicit cost lands null, not zero', async () => {
    const { slaveId } = await seedWorkspaceWithSlave()
    const run = await prisma.$queryRawUnsafe<{ costUsd: number | null }[]>(
      `INSERT INTO "SlaveRun" (id, "slaveId") VALUES (gen_random_uuid(), '${slaveId}') RETURNING "costUsd"`,
    )
    expect(run[0]?.costUsd).toBeNull()
  })
})
