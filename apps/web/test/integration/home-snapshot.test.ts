import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildHomeSnapshot } from '../../src/server/home.js'
import { seedPendingDecision, seedTask, seedWorkspace, truncateAll, type ProjectFixture } from './projectFixture.js'

/** A second (or third) workspace beside `seedWorkspace`'s own, hand-rolled rather than a second
 *  call to it: `seedWorkspace` always names its `Person` 'Alex', and `Person.name` is `@unique`
 *  (`packages/db/prisma/schema.prisma`) -- a second call in the same test would collide on it. */
async function seedSecondWorkspace(name: string, personName: string): Promise<ProjectFixture> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: '/tmp/m61-home-fixture-does-not-need-to-exist', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: personName } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'dev', runtimeRoles: ['dev'], personId: person.id } })
  return { workspaceId: workspace.id, teamId: team.id, slaveId: slave.id, personId: person.id }
}

describe('buildHomeSnapshot', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('gathers needs-you across projects (oldest first), a newest-first feed, and the headline numbers', async (): Promise<void> => {
    // Two visible workspaces, `seedWorkspace`'s own fixed name renamed apart -- `Workspace.name`
    // is `@unique`, and two rows sharing the fixture's default would also make "carries the FIRST
    // workspace's name" true by coincidence rather than by the code under test.
    const a = await seedWorkspace()
    await prisma.workspace.update({ where: { id: a.workspaceId }, data: { name: 'Checkout Platform' } })
    const b = await seedSecondWorkspace('Growth Site', 'Bea')
    // A third, archived -- excluded by `includeArchived: false` from the list AND from the feed
    // and the numbers, per `buildHomeSnapshot`'s own doc comment.
    const archived = await seedSecondWorkspace('Retired Site', 'Cleo')
    await prisma.workspace.update({ where: { id: archived.workspaceId }, data: { archivedAt: new Date() } })

    // Workspace A carries the one thing waiting: a blocked task AND a pending decision about a
    // DIFFERENT subject (the default `subjectId: 'reviewer'`), so `buildNeedsYou` reports both as
    // separate items rather than de-duplicating one into the other (`needsYou.ts`'s own E20 rule).
    const blockedTask = await seedTask(a.workspaceId, { title: 'Ship the checkout redesign', status: 'blocked' })
    await seedPendingDecision(a.workspaceId, { subjectId: 'reviewer' })

    // One live run on A's seat, none on B's -- `numbers.peopleWorking` is the count of DISTINCT
    // seats with a non-terminal run, not a count of runs.
    await prisma.slaveRun.create({ data: { slaveId: a.slaveId, kind: 'implementation', status: 'starting' } })

    // Five `HAPPENING_TYPES` events across both visible workspaces -- three on A, two on B.
    await appendEvent({ type: 'workspace.goal_set', workspaceId: a.workspaceId, actor: 'human', payload: { goal: 'Ship checkout' } })
    await appendEvent({
      type: 'task.created',
      workspaceId: a.workspaceId,
      taskId: blockedTask.id,
      actor: 'human',
      payload: { title: blockedTask.title },
    })
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: a.workspaceId,
      taskId: blockedTask.id,
      actor: 'system',
      payload: { guardrail: 'budget', detail: 'over budget' },
    })
    await appendEvent({ type: 'workspace.goal_set', workspaceId: b.workspaceId, actor: 'human', payload: { goal: 'Grow signups' } })
    const last = await appendEvent({
      type: 'run.started',
      workspaceId: b.workspaceId,
      slaveId: b.slaveId,
      actor: 'slave',
      payload: { sessionId: 'sess-1' },
    })
    void last

    const snapshot = await buildHomeSnapshot()

    expect(snapshot.projects).toHaveLength(2)
    expect(snapshot.projects.map((project) => project.id).sort()).toEqual([a.workspaceId, b.workspaceId].sort())

    // needsYou: two items, both on workspace A, oldest first.
    expect(snapshot.needsYou).toHaveLength(2)
    for (const item of snapshot.needsYou) {
      expect(item.workspaceId).toBe(a.workspaceId)
      expect(item.workspaceName).toBe('Checkout Platform')
    }
    const sinceMs = snapshot.needsYou.map((item) => Date.parse(item.since))
    expect(sinceMs).toEqual([...sinceMs].sort((x, y) => x - y))
    // The blocked task was seeded before the pending decision, so oldest-first puts it first.
    expect(snapshot.needsYou.map((item) => item.kind)).toEqual(['blocked_task', 'decision'])

    // feed: five items, newest first, each naming its project and no bare `word.word` type.
    expect(snapshot.feed).toHaveLength(5)
    const ats = snapshot.feed.map((item) => Date.parse(item.at))
    expect(ats).toEqual([...ats].sort((x, y) => y - x))
    for (const item of snapshot.feed) {
      expect(item.sentence).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect([a.workspaceId, b.workspaceId]).toContain(item.workspaceId)
      expect(['Checkout Platform', 'Growth Site']).toContain(item.workspaceName)
    }
    // Newest event was appended on workspace B (`run.started`).
    expect(snapshot.feed[0]?.workspaceId).toBe(b.workspaceId)
    expect(snapshot.feed[0]?.type).toBe('run.started')

    // numbers: one seat (A's) has a live run.
    expect(snapshot.numbers.peopleWorking).toBe(1)
    expect(snapshot.numbers.spendUsd).toBe(snapshot.projects.reduce((sum, project) => sum + project.spend, 0))

    // includeArchived: false (the default) hides the archived third.
    const withArchived = await buildHomeSnapshot({ includeArchived: true })
    expect(withArchived.projects).toHaveLength(3)
    expect(withArchived.projects.map((project) => project.id)).toContain(archived.workspaceId)

    // I4 (final-review wave): `kpis` costs nothing unless asked for -- `buildAnalytics(null)`'s
    // unscoped read only runs when `includeKpis` is true.
    expect(snapshot.kpis).toEqual([])
    const withKpis = await buildHomeSnapshot({ includeKpis: true })
    expect(withKpis.kpis.length).toBeGreaterThan(0)
    expect(withKpis.kpis.map((kpi) => kpi.label)).toContain('Active slaves')
  })
})
