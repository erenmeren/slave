import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSidebarTree } from '../../src/server/sidebar.js'
import { seedPendingDecision, truncateAll } from './projectFixture.js'

/**
 * The sidebar tree's own read model (M57 R5, plan erratum E3).
 *
 * Its own four queries and NOT `listProjects()`: that function makes six grouped reads plus a
 * `findMany` with a nested include of every team's every slave, and it would run in the ROOT
 * layout — on every page in the product. What the tree draws is a name, a dot and a number.
 */
async function seedProject(
  name: string,
  options: { readonly halted?: boolean; readonly archived?: boolean; readonly autoMerge?: boolean } = {},
): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      repoPath: `/tmp/m57-sidebar-${name}`,
      verifyCommands: ['true'],
      setupCommands: [],
      autoMerge: options.autoMerge ?? false,
      haltedReason: options.halted === true ? 'emergency stop by a test' : null,
      haltedAt: options.halted === true ? new Date() : null,
      archivedAt: options.archived === true ? new Date() : null,
    },
  })
  return workspace.id
}

async function seedTask(workspaceId: string, status: string, integratedAt: Date | null = null): Promise<void> {
  await prisma.task.create({
    data: {
      workspaceId,
      title: `${status} task`,
      description: 'seeded',
      requiredRole: 'dev',
      maxAttempts: 3,
      status: status as never,
      integratedAt,
    },
  })
}

describe('buildSidebarTree', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists every non-archived project by name, ascending -- the order the tree draws', async (): Promise<void> => {
    await seedProject('Zebra')
    await seedProject('Alpha')
    await seedProject('Middle')

    const tree = await buildSidebarTree()

    expect(tree.map((row) => row.name)).toEqual(['Alpha', 'Middle', 'Zebra'])
  })

  it('hides an archived project -- it runs nothing and has nowhere to take you', async (): Promise<void> => {
    await seedProject('Live')
    await seedProject('Filed', { archived: true })

    const tree = await buildSidebarTree()

    expect(tree.map((row) => row.name)).toEqual(['Live'])
  })

  it('gives every row the domain word for the project, not a word of its own', async (): Promise<void> => {
    const idle = await seedProject('Quiet')
    const halted = await seedProject('Stopped', { halted: true })
    const working = await seedProject('Busy')
    await seedTask(working, 'running')

    const tree = await buildSidebarTree()
    const byName = new Map(tree.map((row) => [row.name, row]))

    expect(byName.get('Quiet')?.status).toBe('idle')
    expect(byName.get('Quiet')?.statusLabel).toBe('IDLE')
    expect(byName.get('Stopped')?.status).toBe('halted')
    expect(byName.get('Stopped')?.statusLabel).toBe('HALTED')
    expect(byName.get('Busy')?.status).toBe('working')
    expect(byName.get('Busy')?.statusLabel).toBe('WORKING')
  })

  it('counts a blocked task and a pending decision, and says WAITING FOR YOU', async (): Promise<void> => {
    const workspaceId = await seedProject('Stuck')
    await seedTask(workspaceId, 'blocked')
    await seedPendingDecision(workspaceId, {
      subjectId: 'some-task',
      situationKind: 'task_blocked_human',
      summary: 'a thing',
    })

    const [row] = await buildSidebarTree()

    expect(row?.needsYouCount).toBe(2)
    expect(row?.status).toBe('needs_you')
    expect(row?.statusLabel).toBe('WAITING FOR YOU')
  })

  it('counts un-integrated finished work only on a project that does not merge by itself', async (): Promise<void> => {
    const hand = await seedProject('Hand merge', { autoMerge: false })
    const auto = await seedProject('Auto merge', { autoMerge: true })
    await seedTask(hand, 'done', null)
    await seedTask(auto, 'done', null)

    const tree = await buildSidebarTree()
    const byName = new Map(tree.map((row) => [row.name, row]))

    expect(byName.get('Hand merge')?.needsYouCount).toBe(1)
    expect(byName.get('Auto merge')?.needsYouCount).toBe(0)
  })

  it('counts the active tasks the project row reads as "working"', async (): Promise<void> => {
    const workspaceId = await seedProject('Moving')
    await seedTask(workspaceId, 'running')
    await seedTask(workspaceId, 'verifying')
    await seedTask(workspaceId, 'backlog')

    const [row] = await buildSidebarTree()

    expect(row?.tasksActive).toBe(2)
  })

  it('answers an empty list on an empty installation rather than throwing', async (): Promise<void> => {
    expect(await buildSidebarTree()).toEqual([])
  })
})
