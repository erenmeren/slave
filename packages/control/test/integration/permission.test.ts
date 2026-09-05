import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_TOOLS, setAgentPermission } from '../../src/permission.js'
import { refusalText } from '../../src/refusal.js'

let agentId: string

describe('setAgentPermission', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentPermission", "AgentSkill", "Skill", "SkillProvider", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/perm', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    agentId = (await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists the README six tools, in its order', () => {
    expect(PERMISSION_TOOLS).toEqual(['repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets'])
  })

  it('writes a row and flips it in place rather than adding a second', async (): Promise<void> => {
    expect((await setAgentPermission(agentId, 'repo read', 'allow')).ok).toBe(true)
    expect((await setAgentPermission(agentId, 'repo read', 'deny')).ok).toBe(true)

    const rows = await prisma.agentPermission.findMany({ where: { agentId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mode).toBe('deny')
  })

  it('refuses a tool outside the six with the verbatim text', async (): Promise<void> => {
    const result = await setAgentPermission(agentId, 'rm -rf', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_tool')
      expect(refusalText(result.error)).toBe('a permission must name one of the six tools')
    }
  })

  it('refuses a mode that is neither allow nor deny', async (): Promise<void> => {
    const result = await setAgentPermission(agentId, 'repo read', 'maybe' as 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(refusalText(result.error)).toBe('a permission must be allow or deny')
  })

  it('refuses an unknown agent', async (): Promise<void> => {
    const result = await setAgentPermission('00000000-0000-4000-8000-000000000000', 'repo read', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('agent_not_found')
  })
})
