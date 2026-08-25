import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedWorkspaceWithAgent(): Promise<{ workspaceId: string; agentId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "AgentRun", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('the provider pair columns', () => {
  it('accepts a null cost — an unmeasured run is not a free one', async () => {
    const { agentId } = await seedWorkspaceWithAgent()
    const run = await prisma.agentRun.create({
      // The brief's illustrative test used 'running', which is not a RunStatus member (the real
      // enum has 'starting'/'working'/... -- see schema.prisma). 'working' is the closest match
      // to what the brief meant: an in-flight run.
      data: { agentId, kind: 'implementation', status: 'working', costUsd: null },
    })
    expect(run.costUsd).toBeNull()
    expect(run.provider).toBeNull()
  })

  it('keeps every pre-M12 row readable with a null provider', async () => {
    const { agentId } = await seedWorkspaceWithAgent()
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect(agent.provider).toBeNull()
  })

  it('stamps provider on Agent, AgentTemplate, CompanyAgent, AgentRun and Checkpoint', async () => {
    const { agentId } = await seedWorkspaceWithAgent()

    const template = await prisma.agentTemplate.create({
      data: { name: 'Backend Developer', role: 'backend', provider: 'claude_code' },
    })
    expect(template.provider).toBe('claude_code')

    const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    const companyAgent = await prisma.companyAgent.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', provider: 'cursor' },
    })
    expect(companyAgent.provider).toBe('cursor')

    const stampedAgent = await prisma.agent.update({ where: { id: agentId }, data: { provider: 'claude_code' } })
    expect(stampedAgent.provider).toBe('claude_code')

    const run = await prisma.agentRun.create({ data: { agentId, provider: 'cursor' } })
    expect(run.provider).toBe('cursor')

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
        provider: 'cursor',
      },
    })
    expect(checkpoint.provider).toBe('cursor')
  })

  it('drops the costUsd default so an insert with no explicit cost lands null, not zero', async () => {
    const { agentId } = await seedWorkspaceWithAgent()
    const run = await prisma.$queryRawUnsafe<{ costUsd: number | null }[]>(
      `INSERT INTO "AgentRun" (id, "agentId") VALUES (gen_random_uuid(), '${agentId}') RETURNING "costUsd"`,
    )
    expect(run[0]?.costUsd).toBeNull()
  })
})
