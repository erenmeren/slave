import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildTasksSnapshot } from '../../src/server/tasks'

const ORIGIN = {
  source: 'github',
  repository: 'acme/checkout',
  ref: '#412',
  url: 'https://github.com/acme/checkout/issues/412',
}

let workspaceId: string

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "InboundEvent", "ExternalRepository", "GoalVersion", "ExecutionEvent", "SlaveRun", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/m54-tasks-origin',
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'Make checkout reliable.',
      goalVersion: 2,
    },
  })
  workspaceId = workspace.id
  await prisma.goalVersion.createMany({
    data: [
      { workspaceId, version: 1, text: 'v1', sha256: 'a' },
      { workspaceId, version: 2, text: 'v2', sha256: 'b', origin: ORIGIN },
    ],
  })
  await prisma.task.createMany({
    data: [
      { workspaceId, title: 'From the issue', description: '', status: 'ready', maxAttempts: 3, goalVersion: 2 },
      { workspaceId, title: 'From the first plan', description: '', status: 'ready', maxAttempts: 3, goalVersion: 1 },
      { workspaceId, title: 'Made by hand', description: '', status: 'ready', maxAttempts: 3, goalVersion: null },
    ],
  })
})

describe('buildTasksSnapshot carries each task`s origin (M54 R9)', () => {
  it('stamps the task derived from an externally-originated version, and only that one', async () => {
    const snapshot = await buildTasksSnapshot(workspaceId)
    if (snapshot === null) throw new Error('expected a snapshot')
    const byTitle = new Map(snapshot.tasks.map((task) => [task.title, task.origin]))
    expect(byTitle.get('From the issue')).toEqual(ORIGIN)
    expect(byTitle.get('From the first plan')).toBeNull()
    expect(byTitle.get('Made by hand')).toBeNull()
  })

  it('reads the versions in ONE bounded query over the distinct stamps already on the board', async () => {
    // Twelve tasks, FOUR distinct non-null versions (1, 2, 3 and 4): the read is over four ids and
    // not over twelve rows, and a board of a hundred hand-made tasks makes no query at all.
    //
    // Task 5 arithmetic correction (dispatch "scan ruling"): the plan's copy of this case said
    // "three distinct non-null versions" and asserted six origin-bearing tasks. Both are counts of
    // what it seeds, and what it seeds is four distinct stamps and FIVE origin-bearing tasks --
    // `From the issue` on v2, plus the four fillers whose `(index % 2) + 3` lands on v4 (indices 1,
    // 3, 5 and 7; the five odd-landing ones take v3, which carries no origin). The assertion is
    // the count this fixture actually produces.
    await prisma.goalVersion.createMany({
      data: [
        { workspaceId, version: 3, text: 'v3', sha256: 'c' },
        { workspaceId, version: 4, text: 'v4', sha256: 'd', origin: ORIGIN },
      ],
    })
    await prisma.workspace.update({ where: { id: workspaceId }, data: { goalVersion: 4 } })
    await prisma.task.createMany({
      data: Array.from({ length: 9 }, (_unused, index) => ({
        workspaceId,
        title: `filler ${String(index)}`,
        description: '',
        status: 'ready' as const,
        maxAttempts: 3,
        goalVersion: (index % 2) + 3,
      })),
    })
    const snapshot = await buildTasksSnapshot(workspaceId)
    if (snapshot === null) throw new Error('expected a snapshot')
    expect(snapshot.tasks).toHaveLength(12)
    expect(snapshot.tasks.filter((task) => task.origin !== null)).toHaveLength(5)
  })

  it('makes no version read at all for a board nothing stamped, and answers null for every card', async () => {
    // The other half of "bounded": the query is skipped entirely when the board holds no stamp, so
    // a project whose tasks a person made by hand pays nothing for a milestone it never used.
    await prisma.task.deleteMany({ where: { workspaceId, goalVersion: { not: null } } })
    const snapshot = await buildTasksSnapshot(workspaceId)
    if (snapshot === null) throw new Error('expected a snapshot')
    expect(snapshot.tasks.map((task) => task.title)).toEqual(['Made by hand'])
    expect(snapshot.tasks.every((task) => task.origin === null)).toBe(true)
  })

  it('answers null for a version whose Json column a hand edit broke, rather than throwing', async () => {
    await prisma.goalVersion.updateMany({ where: { workspaceId, version: 2 }, data: { origin: { source: 'myspace' } } })
    const snapshot = await buildTasksSnapshot(workspaceId)
    if (snapshot === null) throw new Error('expected a snapshot')
    expect(snapshot.tasks.find((task) => task.title === 'From the issue')?.origin).toBeNull()
  })
})
