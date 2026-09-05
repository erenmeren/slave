import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildCommunicationGraph, COMMUNICATION_EVENT_LIMIT } from '../../src/server/communicationGraph.js'
import { GET as communicationGraphGET } from '../../src/app/api/w/[workspaceId]/graph/communication/route.js'

// A real directory, not a placeholder (M23 G3 idiom -- see `packages/control/test/integration/
// org-edit.test.ts`'s own comment): a reboot clears /tmp, and `Workspace.repoPath` should point
// at something that exists.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-communication-graph-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly mgrId: string
  readonly alexId: string
  readonly mayaId: string
  readonly samId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const mgr = await prisma.slave.create({ data: { teamId: team.id, name: 'Mgr', role: 'planner' } })
  const alex = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const maya = await prisma.slave.create({ data: { teamId: team.id, name: 'Maya', role: 'reviewer' } })
  // Never emits an event -- proves a slave with no edges still appears as a node.
  const sam = await prisma.slave.create({ data: { teamId: team.id, name: 'Sam', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return {
    workspaceId: workspace.id,
    teamId: team.id,
    mgrId: mgr.id,
    alexId: alex.id,
    mayaId: maya.id,
    samId: sam.id,
    taskId: task.id,
  }
}

describe('buildCommunicationGraph', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildCommunicationGraph('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it(
    'lists every workspace slave as a node (even one with no edges) and derives one edge of each kind from real events',
    async (): Promise<void> => {
      // planner -> implementer: a plan naming t1, then t1's first run.started.
      await appendEvent({
        type: 'workspace.plan_created',
        workspaceId: fixture.workspaceId,
        slaveId: fixture.mgrId,
        actor: 'slave',
        payload: { goal: 'ship it', tasks: [{ id: fixture.taskId, title: 'Add the thing', role: 'backend' }] },
      })
      await appendEvent({
        type: 'run.started',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        slaveId: fixture.alexId,
        actor: 'slave',
        payload: { sessionId: 's1' },
      })
      // implementer -> reviewer: review_started on t1, whose latest run.started named alex.
      await appendEvent({
        type: 'task.review_started',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        slaveId: fixture.mayaId,
        actor: 'slave',
        payload: { title: 'Add the thing' },
      })
      // reviewer -> implementer: review_rejected, then the next run.started on the same task.
      await appendEvent({
        type: 'task.review_rejected',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        slaveId: fixture.mayaId,
        actor: 'slave',
        payload: { reason: 'missing tests', attempt: 1 },
      })
      await appendEvent({
        type: 'run.started',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        slaveId: fixture.alexId,
        actor: 'slave',
        payload: { sessionId: 's2' },
      })
      // operator -> slave: a human message naming alex.
      await appendEvent({
        type: 'slave.message_sent',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        slaveId: fixture.alexId,
        actor: 'human',
        payload: { category: 'instruction', body: 'ship it' },
      })

      const graph = await buildCommunicationGraph(fixture.workspaceId)

      expect(graph?.slaves.map((a) => a.id).sort()).toEqual(
        [fixture.mgrId, fixture.alexId, fixture.mayaId, fixture.samId].sort(),
      )
      // Sam has no events at all -- still a node, no edge touches it.
      expect(graph?.edges.some((e) => e.from === fixture.samId || e.to === fixture.samId)).toBe(false)

      expect(graph?.edges).toEqual(
        expect.arrayContaining([
          { from: fixture.alexId, to: fixture.mayaId, count: 1, kind: 'review' },
          { from: fixture.mayaId, to: fixture.alexId, count: 1, kind: 'rework' },
          { from: fixture.mgrId, to: fixture.alexId, count: 1, kind: 'plan' },
          { from: 'operator', to: fixture.alexId, count: 1, kind: 'message' },
        ]),
      )
      expect(graph?.edges).toHaveLength(4)
    },
  )

  it('the route serves the graph and 404s an unknown workspace', async (): Promise<void> => {
    const ok = await communicationGraphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { slaves: readonly { id: string }[]; edges: readonly unknown[] }
    expect(body.slaves.map((a) => a.id).sort()).toEqual(
      [fixture.mgrId, fixture.alexId, fixture.mayaId, fixture.samId].sort(),
    )
    expect(body.edges).toEqual([])

    const missing = await communicationGraphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('nope')
  })

  it(
    "bounds the fold to the newest COMMUNICATION_EVENT_LIMIT events -- an edge whose events fall entirely " +
      'before the cutoff is dropped, one seeded after it survives',
    async (): Promise<void> => {
      // An "old" plan edge (mgr -> alex), then enough filler events of a queried type to push
      // both of its events out of the newest-COMMUNICATION_EVENT_LIMIT window, then a "new" plan
      // edge (maya -> sam) inside it. Total events of the five queried types =
      // COMMUNICATION_EVENT_LIMIT + 2 (the two the bound must drop) -- exactly the old pair.
      //
      // Chained without awaiting each call individually: `appendEvent` serialises onto ONE
      // process-wide chain by mutating it synchronously at call time (`packages/events/src/
      // append.ts`), so firing every call in this order (still synchronously, in a plain loop)
      // and awaiting them together with `Promise.all` preserves the exact `seq` order this test
      // depends on, without paying for 502 sequential round trips.
      const oldTaskId = fixture.taskId
      const pending: Promise<unknown>[] = []
      pending.push(
        appendEvent({
          type: 'workspace.plan_created',
          workspaceId: fixture.workspaceId,
          slaveId: fixture.mgrId,
          actor: 'slave',
          payload: { goal: 'old', tasks: [{ id: oldTaskId, title: 'Old', role: 'backend' }] },
        }),
      )
      pending.push(
        appendEvent({
          type: 'run.started',
          workspaceId: fixture.workspaceId,
          taskId: oldTaskId,
          slaveId: fixture.alexId,
          actor: 'slave',
          payload: { sessionId: 'old' },
        }),
      )

      const fillerTaskId = 'filler-task'
      for (let i = 0; i < COMMUNICATION_EVENT_LIMIT - 2; i += 1) {
        pending.push(
          appendEvent({
            type: 'task.review_started',
            workspaceId: fixture.workspaceId,
            taskId: fillerTaskId,
            slaveId: fixture.mayaId,
            actor: 'slave',
            payload: { title: 'filler' },
          }),
        )
      }

      const newTaskId = 'new-task'
      pending.push(
        appendEvent({
          type: 'workspace.plan_created',
          workspaceId: fixture.workspaceId,
          slaveId: fixture.mayaId,
          actor: 'slave',
          payload: { goal: 'new', tasks: [{ id: newTaskId, title: 'New', role: 'backend' }] },
        }),
      )
      pending.push(
        appendEvent({
          type: 'run.started',
          workspaceId: fixture.workspaceId,
          taskId: newTaskId,
          slaveId: fixture.samId,
          actor: 'slave',
          payload: { sessionId: 'new' },
        }),
      )

      // 2 (old pair) + (LIMIT - 2) filler + 2 (new pair) = LIMIT + 2 events of the queried types.
      expect(pending.length).toBe(COMMUNICATION_EVENT_LIMIT + 2)
      await Promise.all(pending)

      const graph = await buildCommunicationGraph(fixture.workspaceId)

      expect(graph?.edges).toContainEqual({ from: fixture.mayaId, to: fixture.samId, count: 1, kind: 'plan' })
      expect(graph?.edges).not.toContainEqual(
        expect.objectContaining({ from: fixture.mgrId, to: fixture.alexId, kind: 'plan' }),
      )
    },
  )
})
