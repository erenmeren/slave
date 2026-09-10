import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildNeedsYou } from '../../src/server/needsYou.js'
import {
  seedPendingDecision,
  seedTask,
  seedUnanswerableQuestion,
  seedWorkspace,
  truncateAll,
} from './projectFixture.js'

/**
 * The queue of things waiting on a person (M45 R1, plan erratum E20): FOUR sources, joined once and
 * de-duplicated per task, so the tile's count and the DECISION REQUIRED lane's list can never
 * disagree about how much is waiting.
 */
describe('buildNeedsYou', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists a blocked task, a pending decision, an unanswerable question and un-integrated work', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const { workspaceId } = fixture
    const blocked = await seedTask(workspaceId, {
      title: 'Wire the webhook',
      status: 'blocked',
      lastRejectionReason: 'no credentials',
    })
    const finished = await seedTask(workspaceId, { title: 'Add the banner', status: 'done', integratedAt: null })
    const decision = await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })
    const question = await seedUnanswerableQuestion(fixture, { body: 'Which gateway?' })

    const items = await buildNeedsYou(workspaceId)

    expect(items.map((item) => item.kind).sort()).toEqual(['blocked_task', 'decision', 'integrate', 'question'])
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]))
    expect(byKind['blocked_task']?.title).toContain('Wire the webhook')
    expect(byKind['blocked_task']?.title).toContain('no credentials')
    expect(byKind['blocked_task']?.href).toBe(`/w/${workspaceId}/tasks?task=${blocked.id}`)
    expect(byKind['blocked_task']?.taskId).toBe(blocked.id)
    expect(byKind['decision']?.decisionId).toBe(decision.id)
    // The LABEL, never the enum member (`docs/ia.md` rule 3).
    expect(byKind['decision']?.title).toContain('No reviewer')
    expect(byKind['decision']?.title).not.toContain('no_reviewer')
    expect(byKind['question']?.messageId).toBe(question.messageId)
    expect(byKind['question']?.title).toContain('Which gateway?')
    // E11: there is no web integration verb, so the item LINKS to the task on the board.
    expect(byKind['integrate']?.taskId).toBe(finished.id)
    expect(byKind['integrate']?.href).toBe(`/w/${workspaceId}/tasks?task=${finished.id}`)
    for (const item of items) expect(Date.parse(item.since)).not.toBeNaN()
  })

  it('does not ask for an integration on a project that merges by itself', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: true })
    await seedTask(workspaceId, { title: 'Add the banner', status: 'done', integratedAt: null })

    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })

  it('counts a blocked task with a pending decision about it ONCE, as the decision', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const blocked = await seedTask(workspaceId, { title: 'Wire the webhook', status: 'blocked' })
    await seedPendingDecision(workspaceId, {
      subjectId: blocked.id,
      situationKind: 'task_blocked_human',
      summary: 'the webhook task has been blocked for two days',
    })

    const items = await buildNeedsYou(workspaceId)

    // ONE entry for one task. Two would double-count the same piece of work in the tile's number
    // and put two rows in front of a person for one thing to decide (plan erratum E20).
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('decision')
    expect(items[0]?.taskId).toBeNull()
  })

  it('is oldest first -- the thing that has waited longest is the thing to do', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const older = await seedTask(workspaceId, {
      title: 'Older',
      status: 'blocked',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    await seedTask(workspaceId, {
      title: 'Newer',
      status: 'blocked',
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
    })

    const items = await buildNeedsYou(workspaceId)

    expect(items[0]?.taskId).toBe(older.id)
  })

  it('answers an empty list for a project where nothing is waiting', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })

    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })

  it('answers an empty list for a project that does not exist', async (): Promise<void> => {
    expect(await buildNeedsYou('00000000-0000-0000-0000-000000000000')).toEqual([])
  })
})
