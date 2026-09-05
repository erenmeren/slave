import { Prisma, prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { skillCallTotals } from '../../src/server/skills.js'

/**
 * The equivalence oracle for `skillCallTotals`: the OLD in-memory computation, copied verbatim
 * from `buildSkillsPage` (`skills.ts` before this change) as the ground truth the SQL must match.
 * This function must never be "improved" to track the implementation — it is the fixed point the
 * SQL is proven against.
 */
async function oldTotals(): Promise<Map<string, number>> {
  const runs = await prisma.agentRun.findMany({ where: { skillCalls: { not: Prisma.DbNull } }, select: { skillCalls: true } })
  const totals = new Map<string, number>()
  for (const run of runs) {
    for (const [name, count] of Object.entries((run.skillCalls as Record<string, unknown> | null) ?? {})) {
      if (typeof count !== 'number' || !Number.isFinite(count)) continue
      totals.set(name, (totals.get(name) ?? 0) + count)
    }
  }
  return totals
}

let agentId: string

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  const workspace = await prisma.workspace.create({
    data: { name: 'W', repoPath: '/tmp/skill-call-totals', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
  agentId = (await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('skillCallTotals equivalence', () => {
  it('matches the in-memory sum on every skillCalls shape the writer produces', async () => {
    await prisma.agentRun.create({
      data: {
        agentId,
        status: 'succeeded',
        provider: 'claude_code',
        skillCalls: { 'superpowers:writing-plans': 2, brainstorming: 5 },
      },
    })
    await prisma.agentRun.create({
      data: { agentId, status: 'succeeded', provider: 'claude_code', skillCalls: { brainstorming: 1, '<unnamed>': 3 } },
    })
    await prisma.agentRun.create({
      data: { agentId, status: 'failed', provider: 'claude_code', skillCalls: { broken: 'not-a-number', fine: 2 } },
    })
    // A Cursor run: `Prisma.DbNull` is SQL NULL on the nullable Json column, and contributes nothing.
    await prisma.agentRun.create({ data: { agentId, status: 'succeeded', provider: 'cursor', skillCalls: Prisma.DbNull } })

    const expected = await oldTotals()
    const actual = await skillCallTotals()
    expect(new Map(actual)).toEqual(expected)
    expect(actual.get('brainstorming')).toBe(6) // and the absolute numbers, not just agreement
    expect(actual.get('fine')).toBe(2)
    expect(actual.has('broken')).toBe(false)
  })
})
