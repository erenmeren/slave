import { prisma } from '@slave-of-ai/db/client'
import { GOAL_DECISIONS_MAX } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { recordLeadDecisions } from '../../src/lead/decisions.js'

const decisions = (from: number, count: number): { title: string; decision: string }[] =>
  Array.from({ length: count }, (_, i) => ({ title: `D${String(from + i)}`, decision: `text ${String(from + i)}` }))

describe('recordLeadDecisions (lead-flow spec B9)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "GoalDecision", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('counts titles the version already has as known, also at the cap, and only new ones past the cap as refused (task 7 review)', async (): Promise<void> => {
    const ws = await prisma.workspace.create({ data: { name: `Decisions ${String(Math.random()).slice(2)}`, repoPath: '/tmp/decisions', verifyCommands: ['true'], setupCommands: [] } })
    const all = decisions(0, GOAL_DECISIONS_MAX)
    expect(await recordLeadDecisions(ws.id, 1, all)).toEqual({ written: GOAL_DECISIONS_MAX, known: 0, refused: 0 })

    // The file is read again after the next turn: every title is known, at the cap -- nothing refused.
    expect(await recordLeadDecisions(ws.id, 1, all)).toEqual({ written: 0, known: GOAL_DECISIONS_MAX, refused: 0 })
    // A title spelled with other case and spacing is the same title.
    expect(await recordLeadDecisions(ws.id, 1, [{ title: '  d0 ', decision: 'again' }])).toEqual({ written: 0, known: 1, refused: 0 })
    // Two new titles past the cap, one of them twice: two refused, the known ones still known.
    expect(await recordLeadDecisions(ws.id, 1, [...decisions(0, 2), ...decisions(100, 2), { title: 'D100', decision: 'twice' }])).toEqual({ written: 0, known: 2, refused: 2 })
    expect(await prisma.goalDecision.count({ where: { workspaceId: ws.id } })).toBe(GOAL_DECISIONS_MAX)
  })

  it('counts a title repeated within one read as known after its first write', async (): Promise<void> => {
    const ws = await prisma.workspace.create({ data: { name: `Decisions ${String(Math.random()).slice(2)}`, repoPath: '/tmp/decisions', verifyCommands: ['true'], setupCommands: [] } })
    expect(await recordLeadDecisions(ws.id, 1, [{ title: 'Port', decision: '8080' }, { title: 'port', decision: '9090' }])).toEqual({ written: 1, known: 1, refused: 0 })
  })
})
