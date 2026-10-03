import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildHomeSnapshot } from '../../src/server/home.js'
import { buildNeedsYou, type NeedsYouItem } from '../../src/server/needsYou.js'
import { listProjects } from '../../src/server/org.js'
import { buildOverviewSnapshot } from '../../src/server/overview.js'
import { buildSidebarTree } from '../../src/server/sidebar.js'
import { seedPendingDecision, seedUnanswerableQuestion, seedWorkspace, truncateAll } from './projectFixture.js'

/**
 * Human cards H4 (plan B D8, Task 9): the strip, the Overview, Home and the sidebar read one queue,
 * so the numbers they show agree for the same data -- the sidebar's needs-you count with the items
 * the rows hold (each row's own plus what merged into it), its blocking count with the rows that
 * block a version, and Home and the Overview with the strip, item for item.
 */
async function task(workspaceId: string, data: { readonly title: string; readonly status: string; readonly goalVersion: number }): Promise<string> {
  const row = await prisma.task.create({
    data: { workspaceId, title: data.title, description: 'seeded', status: data.status as never, requiredRole: 'dev', maxAttempts: 3, goalVersion: data.goalVersion },
  })
  return row.id
}

async function card(workspaceId: string, situationKind: string, subjectId: string, createdAt: Date): Promise<string> {
  const row = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: situationKind as never,
      subjectId,
      situation: { kind: situationKind, subjectId, summary: `about ${subjectId}`, facts: {} },
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'escalate_to_human', summary: 'a person decides' },
      rationale: 'seeded',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'rules',
      modelCalled: false,
      createdAt,
    },
  })
  return row.id
}

const itemsOf = (rows: readonly NeedsYouItem[]): number => rows.reduce((sum, row) => sum + 1 + row.mergedIds.length, 0)

describe('one queue, one set of numbers (human cards H4)', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('counts the same things on the sidebar, the strip, the Overview and Home', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const { workspaceId } = fixture
    // v2: a run parked on its question, with a card -- blocking.
    const asking = await task(workspaceId, { title: 'Pick the gateway', status: 'waiting', goalVersion: 2 })
    const question = await seedUnanswerableQuestion(fixture, { taskId: asking })
    await card(workspaceId, 'unanswerable_question', question.messageId, new Date(Date.UTC(2026, 9, 3, 8, 30)))
    // v1: a blocked task and the task_blocked_human card about it -- one row, blocking.
    const blocked = await task(workspaceId, { title: 'Wire the webhook', status: 'blocked', goalVersion: 1 })
    await card(workspaceId, 'task_blocked_human', blocked, new Date(Date.UTC(2026, 9, 3, 8, 20)))
    // v1: a verification card that blocks nothing; and a project-level staffing card.
    await card(workspaceId, 'verification_failed', `${workspaceId}:v1:r1`, new Date(Date.UTC(2026, 9, 3, 8, 0)))
    await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })

    const strip = await buildNeedsYou(workspaceId)
    const sidebar = (await buildSidebarTree()).find((row) => row.id === workspaceId)
    const projectRow = (await listProjects()).find((row) => row.id === workspaceId)
    const overview = await buildOverviewSnapshot(workspaceId)
    const home = (await buildHomeSnapshot()).needsYou.filter((item) => item.workspaceId === workspaceId)

    // Four rows; five items (the blocked task rides on its card's row).
    expect(strip).toHaveLength(4)
    expect(itemsOf(strip)).toBe(5)
    expect(sidebar?.needsYouCount).toBe(itemsOf(strip))
    expect(projectRow?.needsYou).toBe(itemsOf(strip))
    // What blocks a version: the parked question and the needs_human card, counted alike everywhere.
    expect(strip.filter((row) => row.blocking)).toHaveLength(2)
    expect(sidebar?.blockingCount).toBe(2)
    expect(home.filter((row) => row.blocking)).toHaveLength(2)
    // The Overview's tile and its strip read the very queue the strip reads, row for row.
    expect(overview?.needsYou.map((row) => row.id)).toEqual(strip.map((row) => row.id))
    expect(overview?.brief.needsYou.map((row) => row.id)).toEqual(strip.map((row) => row.id))
    // Home holds the same rows (in its own order: what blocks first, then the oldest).
    expect([...home.map((row) => row.id)].sort()).toEqual([...strip.map((row) => row.id)].sort())
    expect(itemsOf(home)).toBe(itemsOf(strip))
    expect(home.map((row) => row.blocking)).toEqual([true, true, false, false])
  })

  it('counts a run parked on a question nobody can answer as blocking, and Home still lists it', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const asking = await task(fixture.workspaceId, { title: 'Pick the gateway', status: 'waiting', goalVersion: 1 })
    await seedUnanswerableQuestion(fixture, { taskId: asking })

    const sidebar = (await buildSidebarTree()).find((row) => row.id === fixture.workspaceId)
    const strip = await buildNeedsYou(fixture.workspaceId)
    const home = (await buildHomeSnapshot()).needsYou.filter((item) => item.workspaceId === fixture.workspaceId)

    expect(sidebar?.blockingCount).toBe(1)
    expect(strip.filter((row) => row.blocking)).toHaveLength(1)
    // No task or decision stands behind it, so the needs-you count alone would have left Home empty.
    expect(sidebar?.needsYouCount).toBe(0)
    expect(home.map((row) => [row.kind, row.blocking])).toEqual([['question', true]])
  })

  // Task 9 fix round 1 (ruling I2): the sidebar's count IS the queue's blocking rows. Case A: a
  // blocked task whose card is review_cap_blocked or task_failed, or that has no card, is a blocking
  // row -- the sidebar counts it too.
  it('counts a blocked task as blocking whatever card it has, or none (case A)', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const capped = await task(workspaceId, { title: 'Capped', status: 'blocked', goalVersion: 1 })
    const failed = await task(workspaceId, { title: 'Failed', status: 'blocked', goalVersion: 1 })
    await task(workspaceId, { title: 'Uncarded', status: 'blocked', goalVersion: 1 })
    await card(workspaceId, 'review_cap_blocked', capped, new Date(Date.UTC(2026, 9, 3, 8, 0)))
    await card(workspaceId, 'task_failed', failed, new Date(Date.UTC(2026, 9, 3, 8, 5)))

    const sidebar = (await buildSidebarTree()).find((row) => row.id === workspaceId)
    const strip = await buildNeedsYou(workspaceId)
    const home = (await buildHomeSnapshot()).needsYou.filter((item) => item.workspaceId === workspaceId)

    expect(strip.filter((row) => row.blocking)).toHaveLength(3)
    expect(sidebar?.blockingCount).toBe(3)
    expect(home.filter((row) => row.blocking)).toHaveLength(3)
  })

  // Case B: a run parked on a question a SLAVE can answer is the fleet waiting on itself -- nothing a
  // person can act on, so no blocking count, no row, and Home lists nothing for the project.
  it('does not count a run parked on a question a slave can answer (case B)', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const person = await prisma.person.create({ data: { name: 'Bianca' } })
    await prisma.slave.create({ data: { teamId: fixture.teamId, role: 'dev', runtimeRoles: ['dev'], personId: person.id } })
    const asking = await task(fixture.workspaceId, { title: 'Pick the gateway', status: 'waiting', goalVersion: 1 })
    const run = await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, taskId: asking, kind: 'planning', status: 'paused', pauseReason: 'waiting_for_answer' } })
    await prisma.slaveMessage.create({
      data: { workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, taskId: asking, senderRunId: run.id, threadId: 't', kind: 'question', body: 'Which gateway?', actor: 'slave', expectsReply: true, recipientRole: 'dev' },
    })

    const sidebar = (await buildSidebarTree()).find((row) => row.id === fixture.workspaceId)
    const strip = await buildNeedsYou(fixture.workspaceId)
    const home = await buildHomeSnapshot()

    expect(strip).toEqual([])
    expect(sidebar?.blockingCount).toBe(0)
    expect(home.needsYou.filter((item) => item.workspaceId === fixture.workspaceId)).toEqual([])
  })

  it('counts nothing for an empty queue', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })

    const sidebar = (await buildSidebarTree()).find((row) => row.id === workspaceId)

    expect(await buildNeedsYou(workspaceId)).toEqual([])
    expect(sidebar?.needsYouCount).toBe(0)
    expect(sidebar?.blockingCount).toBe(0)
    expect((await buildHomeSnapshot()).needsYou).toEqual([])
  })
})
