import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildGraphSnapshot } from '../../src/server/graph.js'
import { GET as graphGET } from '../../src/app/api/w/[workspaceId]/graph/route.js'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly agentId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/graph-snapshot-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, teamId: team.id, agentId: agent.id, taskId: task.id }
}

describe('buildGraphSnapshot', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildGraphSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('carries the workspace and team', async (): Promise<void> => {
    const snapshot = await buildGraphSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace).toEqual({ id: fixture.workspaceId, name: 'Checkout Platform', haltedReason: null })
    expect(snapshot?.teams).toEqual([{ id: fixture.teamId, name: 'Engineering' }])
  })

  it('wires an agent to its active run: activeTaskId, activeTaskTitle, activeRunId', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 2.5 },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    const snapshot = await buildGraphSnapshot(fixture.workspaceId)
    const agent = snapshot?.agents[0]

    expect(agent?.id).toBe(fixture.agentId)
    expect(agent?.teamId).toBe(fixture.teamId)
    expect(agent?.status).toBe('working')
    expect(agent?.activeTaskId).toBe(fixture.taskId)
    expect(agent?.activeTaskTitle).toBe('Add the thing')
    expect(agent?.activeRunId).toBe(run.id)
  })

  // M12 Task 13 fix round 1, spec gap 4c: `GraphAgent.costUsd` is deleted (no renderer ever
  // consumed it, per the controller's ruling) -- the test that once existed here asserted only
  // that DTO field, on a run seeded the same way `wires an agent...` above already does, so it is
  // removed rather than left asserting nothing. `AgentRun.costUsd` itself is untouched and still
  // exercised by `overview.test.ts` and `server-org.test.ts`, which actually read it.

  it('reports an idle agent with no live run as null-wired', async (): Promise<void> => {
    const snapshot = await buildGraphSnapshot(fixture.workspaceId)
    const agent = snapshot?.agents[0]

    expect(agent?.status).toBe('idle')
    expect(agent?.activeTaskId).toBeNull()
    expect(agent?.activeTaskTitle).toBeNull()
    expect(agent?.activeRunId).toBeNull()
  })

  it('matches the scheduler\'s dependenciesDone definition: false while a dependency is not done, true once it is', async (): Promise<void> => {
    const taskB = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Task B',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.taskDependency.create({ data: { taskId: fixture.taskId, dependsOnTaskId: taskB.id } })

    const before = await buildGraphSnapshot(fixture.workspaceId)
    const taskA_before = before?.tasks.find((t) => t.id === fixture.taskId)
    expect(taskA_before?.dependenciesDone).toBe(false)

    await prisma.task.update({ where: { id: taskB.id }, data: { status: 'done' } })

    const after = await buildGraphSnapshot(fixture.workspaceId)
    const taskA_after = after?.tasks.find((t) => t.id === fixture.taskId)
    expect(taskA_after?.dependenciesDone).toBe(true)
  })

  it('reports dependenciesDone true for a task with no dependencies at all', async (): Promise<void> => {
    const snapshot = await buildGraphSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === fixture.taskId)

    expect(task?.dependenciesDone).toBe(true)
    expect(task?.title).toBe('Add the thing')
    expect(task?.status).toBe('running')
    expect(task?.attempt).toBe(0)
    expect(task?.maxAttempts).toBe(3)
  })

  it('lists the dependency edges', async (): Promise<void> => {
    const taskB = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Task B',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.taskDependency.create({ data: { taskId: fixture.taskId, dependsOnTaskId: taskB.id } })

    const snapshot = await buildGraphSnapshot(fixture.workspaceId)

    expect(snapshot?.dependencies).toEqual([{ taskId: fixture.taskId, dependsOnTaskId: taskB.id }])
  })

  it('does not leak another workspace\'s teams, agents, tasks or dependencies', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other-graph', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend' } })
    await prisma.task.create({
      data: { workspaceId: other.id, title: 'Other task', description: 'x', requiredRole: 'backend', maxAttempts: 3 },
    })

    const snapshot = await buildGraphSnapshot(fixture.workspaceId)

    expect(snapshot?.agents.map((a) => a.name)).toEqual(['Alex'])
    expect(snapshot?.teams.map((t) => t.name)).toEqual(['Engineering'])
    expect(snapshot?.tasks.map((t) => t.title)).toEqual(['Add the thing'])
  })

  it('the route serves the snapshot and 404s an unknown workspace', async (): Promise<void> => {
    const ok = await graphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { workspace: { name: string } }
    expect(body.workspace.name).toBe('Checkout Platform')

    const missing = await graphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('nope')
  })
})
