import { agentId, taskId, workspaceId } from '@ai-team-os/domain'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadWorld } from '../../src/world.js'

/**
 * One workspace wired up to exercise every branch `loadWorld` has to get right:
 *
 *  - `doneDep` -> `readyTask` -> `blockedTask` is a two-hop dependency chain, done at the near
 *    end and unsatisfied at the far end, so the "every dependency done" SQL has to walk past a
 *    single vacuously-true case (`doneDep` itself has no dependencies) to prove it isn't just
 *    returning true unconditionally.
 *  - `roleless` has no `requiredRole` -- the one case spec §4 says gets excluded from the
 *    schedulable set and counted, not silently dropped.
 *  - `agentWithRun` holds a `working` (non-terminal) run, `idleAgent` holds none, and
 *    `retiredRunAgent` holds a `succeeded` (terminal) one -- so "busy" can't be satisfied by
 *    "has ever had a run".
 */
interface Fixture {
  readonly workspaceId: string
  readonly doneDepTaskId: string
  readonly readyTaskId: string
  readonly blockedTaskId: string
  readonly rolelessTaskId: string
  readonly agentWithRunId: string
  readonly idleAgentId: string
  readonly retiredRunAgentId: string
}

async function seedFixture(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })

  const agentWithRun = await prisma.agent.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend' },
  })
  const idleAgent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Blair', role: 'backend' },
  })
  const retiredRunAgent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Casey', role: 'backend' },
  })

  const doneDep = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'doneDep',
      description: 'already merged',
      status: 'done',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const readyTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'readyTask',
      description: 'depends on doneDep, which is done',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  await prisma.taskDependency.create({ data: { taskId: readyTask.id, dependsOnTaskId: doneDep.id } })

  const blockedTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'blockedTask',
      description: 'depends on readyTask, which is not done',
      status: 'blocked',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  await prisma.taskDependency.create({ data: { taskId: blockedTask.id, dependsOnTaskId: readyTask.id } })

  const rolelessTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'roleless',
      description: 'nobody can pick this up yet',
      status: 'ready',
      maxAttempts: workspace.maxAttempts,
    },
  })

  const workingTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'workingTask',
      description: 'hosts the non-terminal run',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  await prisma.agentRun.create({
    data: { taskId: workingTask.id, agentId: agentWithRun.id, status: 'working' },
  })

  const doneRunTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'doneRunTask',
      description: 'hosts the terminal run',
      status: 'done',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  await prisma.agentRun.create({
    data: { taskId: doneRunTask.id, agentId: retiredRunAgent.id, status: 'succeeded' },
  })

  return {
    workspaceId: workspace.id,
    doneDepTaskId: doneDep.id,
    readyTaskId: readyTask.id,
    blockedTaskId: blockedTask.id,
    rolelessTaskId: rolelessTask.id,
    agentWithRunId: agentWithRun.id,
    idleAgentId: idleAgent.id,
    retiredRunAgentId: retiredRunAgent.id,
  }
}

describe('loadWorld', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seedFixture()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('marks a task ready only when every dependency is done', async (): Promise<void> => {
    const { world } = await loadWorld(workspaceId(fixture.workspaceId))

    const blocked = world.tasks.find((t) => t.id === taskId(fixture.blockedTaskId))
    expect(blocked?.dependenciesDone).toBe(false)

    // The task one hop closer to the (done) root, and the root itself: both vacuously-true-or-
    // genuinely-satisfied cases the SQL has to get right, not just the negative one above.
    const ready = world.tasks.find((t) => t.id === taskId(fixture.readyTaskId))
    expect(ready?.dependenciesDone).toBe(true)
    const done = world.tasks.find((t) => t.id === taskId(fixture.doneDepTaskId))
    expect(done?.dependenciesDone).toBe(true)
  })

  it('counts tasks with no required role instead of silently dropping them', async (): Promise<void> => {
    const { world, skippedNoRole } = await loadWorld(workspaceId(fixture.workspaceId))

    expect(world.tasks.some((t) => t.id === taskId(fixture.rolelessTaskId))).toBe(false)
    expect(skippedNoRole).toBe(1)
  })

  it('reports an agent busy only while it holds a non-terminal run', async (): Promise<void> => {
    const { world } = await loadWorld(workspaceId(fixture.workspaceId))

    expect(world.agents.find((a) => a.id === agentId(fixture.agentWithRunId))?.busy).toBe(true)
    expect(world.agents.find((a) => a.id === agentId(fixture.idleAgentId))?.busy).toBe(false)
    // Held a run once, but it finished. "Busy" can't be implemented as "has any AgentRun row" --
    // that would trap an agent as permanently busy after its first completed run.
    expect(world.agents.find((a) => a.id === agentId(fixture.retiredRunAgentId))?.busy).toBe(false)
  })

  it('reports stats.emergencyStopped from Workspace.haltedReason, never a hardcoded value', async (): Promise<void> => {
    const { world: unhalted } = await loadWorld(workspaceId(fixture.workspaceId))
    expect(unhalted.stats.emergencyStopped).toBe(false)

    const halted = await prisma.workspace.create({
      data: {
        name: 'Halted Workspace',
        repoPath: '/tmp/halted',
        verifyCommands: ['npm test'],
        setupCommands: ['npm ci'],
        haltedReason: 'pause gate denied a tool call',
        haltedAt: new Date(),
      },
    })

    const { world: haltedWorld } = await loadWorld(workspaceId(halted.id))
    expect(haltedWorld.stats.emergencyStopped).toBe(true)
  })
})
