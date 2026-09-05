import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { addTaskDependency, removeTaskDependency } from '../../src/dependency.js'

interface Fixture {
  readonly workspace: { readonly id: string }
  readonly otherWorkspace: { readonly id: string }
  readonly a: { readonly id: string; readonly title: string }
  readonly b: { readonly id: string; readonly title: string }
  readonly c: { readonly id: string; readonly title: string }
  readonly outside: { readonly id: string; readonly title: string }
}

/**
 * A workspace with three tasks (A, B, C) plus one task in a second workspace, so cycle-chain
 * cases (A->B->C then C->A) and cross-workspace refusals can both be built from the same seed.
 */
async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-dependency-'))
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const otherRepoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-dependency-other-'))
  const otherWorkspace = await prisma.workspace.create({
    data: {
      name: 'Other Platform',
      repoPath: otherRepoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })

  const makeTask = async (workspaceId: string, title: string, status: 'backlog' | 'done' = 'backlog') =>
    prisma.task.create({
      data: {
        workspaceId,
        title,
        description: `${title} description`,
        maxAttempts: workspace.maxAttempts,
        status,
      },
    })

  const a = await makeTask(workspace.id, 'Task A')
  const b = await makeTask(workspace.id, 'Task B')
  const c = await makeTask(workspace.id, 'Task C')
  const outside = await makeTask(otherWorkspace.id, 'Outside Task')

  return {
    workspace: { id: workspace.id },
    otherWorkspace: { id: otherWorkspace.id },
    a: { id: a.id, title: a.title },
    b: { id: b.id, title: b.title },
    c: { id: c.id, title: c.title },
    outside: { id: outside.id, title: outside.title },
  }
}

describe('task dependency control operations', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('addTaskDependency', () => {
    it('adds the edge and appends task.dependency_added', async (): Promise<void> => {
      const { a, b } = fixture
      const result = await addTaskDependency(a.id, b.id, 'meren')
      expect(result.ok).toBe(true)

      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: a.id, dependsOnTaskId: b.id } },
      })
      expect(row).not.toBeNull()

      const event = await prisma.executionEvent.findFirst({
        where: { taskId: a.id, type: 'task_dependency_added' },
      })
      expect(event?.payload).toEqual({ dependsOnTaskId: b.id, dependsOnTitle: b.title, requestedBy: 'meren' })
      expect(event?.actor).toBe('human')
    })

    it('refuses a task depending on itself', async (): Promise<void> => {
      const { a } = fixture
      const result = await addTaskDependency(a.id, a.id, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('self_dependency')
    })

    it('refuses a duplicate edge', async (): Promise<void> => {
      const { a, b } = fixture
      await addTaskDependency(a.id, b.id, 'meren')
      const result = await addTaskDependency(a.id, b.id, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('duplicate_dependency')
    })

    it('refuses an edge across workspaces', async (): Promise<void> => {
      const { a, outside } = fixture
      const result = await addTaskDependency(a.id, outside.id, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('cross_workspace')
    })

    it('refuses an unknown task', async (): Promise<void> => {
      const { a } = fixture
      const unknown = '00000000-0000-4000-8000-000000000000'
      const result = await addTaskDependency(a.id, unknown, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('task_not_found')
    })

    it('refuses the unknown task even when it is the primary id', async (): Promise<void> => {
      const { a } = fixture
      const unknown = '00000000-0000-4000-8000-000000000000'
      const result = await addTaskDependency(unknown, a.id, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('task_not_found')
    })

    it('refuses a chain cycle: A->B->C standing, then C depends on A', async (): Promise<void> => {
      const { a, b, c } = fixture
      expect((await addTaskDependency(a.id, b.id, 'meren')).ok).toBe(true) // A depends on B
      expect((await addTaskDependency(b.id, c.id, 'meren')).ok).toBe(true) // B depends on C

      const result = await addTaskDependency(c.id, a.id, 'meren') // C depends on A would close the loop
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('dependency_cycle')

      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: c.id, dependsOnTaskId: a.id } },
      })
      expect(row).toBeNull()
    })

    it('refuses the direct 2-cycle: B depends on A standing, then A depends on B', async (): Promise<void> => {
      const { a, b } = fixture
      expect((await addTaskDependency(b.id, a.id, 'meren')).ok).toBe(true) // B depends on A

      const result = await addTaskDependency(a.id, b.id, 'meren') // A depends on B would close the loop
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('dependency_cycle')
    })

    it('serialises concurrent opposite-direction adds so the DAG cannot acquire a cycle', async (): Promise<void> => {
      const { a, b } = fixture

      // Two operators racing to add A->B and B->A at the same instant. Under READ COMMITTED with
      // no lock, both transactions' cycle CTEs would run before either's INSERT commits -- neither
      // sees the other's uncommitted row, both CTEs report "no cycle", and both inserts land: a
      // live cycle in "TaskDependency" that `dependenciesDone` (apps/orchestrator/src/world.ts)
      // would then evaluate as permanently false for both tasks, forever, with nothing to explain
      // why. Exactly one of these two calls must win.
      const [first, second] = await Promise.all([
        addTaskDependency(a.id, b.id, 'meren'),
        addTaskDependency(b.id, a.id, 'meren'),
      ])

      const results = [first, second]
      const succeeded = results.filter((r) => r.ok)
      const refused = results.filter((r) => !r.ok)
      expect(succeeded).toHaveLength(1)
      expect(refused).toHaveLength(1)
      if (!refused[0]!.ok) expect(refused[0]!.error.kind).toBe('dependency_cycle')

      const rows = await prisma.taskDependency.findMany({ where: { OR: [{ taskId: a.id }, { taskId: b.id }] } })
      expect(rows).toHaveLength(1)
    })

    it('allows depending on a task that is already done', async (): Promise<void> => {
      const { a } = fixture
      const done = await prisma.task.create({
        data: {
          workspaceId: fixture.workspace.id,
          title: 'Already done',
          description: 'finished work',
          maxAttempts: 3,
          status: 'done',
        },
      })

      const result = await addTaskDependency(a.id, done.id, 'meren')
      expect(result.ok).toBe(true)

      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: a.id, dependsOnTaskId: done.id } },
      })
      expect(row).not.toBeNull()
    })
  })

  describe('removeTaskDependency', () => {
    it('removes the edge and appends task.dependency_removed', async (): Promise<void> => {
      const { a, b } = fixture
      await addTaskDependency(a.id, b.id, 'meren')

      const result = await removeTaskDependency(a.id, b.id, 'meren')
      expect(result.ok).toBe(true)

      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: a.id, dependsOnTaskId: b.id } },
      })
      expect(row).toBeNull()

      const event = await prisma.executionEvent.findFirst({
        where: { taskId: a.id, type: 'task_dependency_removed' },
      })
      expect(event?.payload).toEqual({ dependsOnTaskId: b.id, dependsOnTitle: b.title, requestedBy: 'meren' })
      expect(event?.actor).toBe('human')
    })

    it('refuses removing an edge that does not exist', async (): Promise<void> => {
      const { a, b } = fixture
      const result = await removeTaskDependency(a.id, b.id, 'meren')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('dependency_not_found')
    })
  })
})
