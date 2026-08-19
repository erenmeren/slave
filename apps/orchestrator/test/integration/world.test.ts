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

/**
 * A run to seed, described the way the streak algorithm sees it. `terminalAt: null` is the
 * *current* state of every row in the database -- nothing writes that column yet -- so it is the
 * default here rather than something a test has to opt into.
 */
interface RunSpec {
  readonly status: 'succeeded' | 'failed' | 'stopped' | 'working'
  readonly startedAt: Date
  readonly terminalAt?: Date | null
  readonly costUsd?: number
}

/**
 * A workspace of its own, holding one run per spec. Separate from `seedFixture`'s workspace so
 * that fixture's own `working`/`succeeded` runs cannot leak into a streak or an `activeRuns`
 * count and make an assertion pass for the wrong reason.
 */
async function seedRuns(specs: readonly RunSpec[]): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Streak Workspace',
      repoPath: '/tmp/streak',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Dana', role: 'backend' },
  })

  for (const [index, spec] of specs.entries()) {
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `streak-${index}`,
        description: `hosts run ${index}`,
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: workspace.maxAttempts,
      },
    })
    await prisma.agentRun.create({
      data: {
        taskId: task.id,
        agentId: agent.id,
        status: spec.status,
        startedAt: spec.startedAt,
        terminalAt: spec.terminalAt ?? null,
        costUsd: spec.costUsd ?? 0,
      },
    })
  }

  return workspace.id
}

const at = (iso: string): Date => new Date(iso)

/**
 * `stats.consecutiveFailures` feeds `evaluateGuardrails`, where reaching
 * `consecutiveFailureLimit` yields `haltsScheduling: true` and `decide()` returns `halt` on every
 * tick. Nothing else in the codebase asserts this algorithm, and its wrong answer is not a wrong
 * number on a dashboard -- it is a workspace that stops scheduling and, because the halt prevents
 * the very runs that would break the streak, cannot recover on its own. Every behaviour below is
 * therefore pinned deliberately, so that when Task 16 gives the operator a reset lever, whatever
 * it changes here is visibly a decision rather than an accident.
 */
describe('loadWorld stats.consecutiveFailures', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('counts an unbroken run of failures from the most recently concluded backwards', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'failed', startedAt: at('2026-01-01T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-02T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-03T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    expect(world.stats.consecutiveFailures).toBe(3)
  })

  it('stops counting at the first success, however many failures precede it', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'failed', startedAt: at('2026-01-01T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-02T00:00:00Z') },
      { status: 'succeeded', startedAt: at('2026-01-03T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-04T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // The two older failures are behind a success and are not part of the current streak.
    expect(world.stats.consecutiveFailures).toBe(1)
  })

  it('treats an operator stop as neither a failure nor a reset', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'failed', startedAt: at('2026-01-01T00:00:00Z') },
      { status: 'stopped', startedAt: at('2026-01-02T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-03T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // An operator stopping a run is not the run failing, so it adds nothing -- and it must not
    // launder a real streak away either, so the two failures either side of it still join up.
    expect(world.stats.consecutiveFailures).toBe(2)
  })

  it('does not let an in-flight run break the streak', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'failed', startedAt: at('2026-01-01T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-02T00:00:00Z') },
      { status: 'working', startedAt: at('2026-01-03T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // The newest run has not concluded either way. Counting it as a break would clear the breaker
    // the instant a run started, which is exactly when the breaker is supposed to still be armed.
    expect(world.stats.consecutiveFailures).toBe(2)
  })

  it('orders by when a run concluded, falling back to startedAt while terminalAt is unwritten', async (): Promise<void> => {
    const id = await seedRuns([
      // Legacy rows: written before anything populated `terminalAt`, which is every concluded run
      // in the database today.
      { status: 'failed', startedAt: at('2019-01-01T00:00:00Z') },
      { status: 'failed', startedAt: at('2019-01-02T00:00:00Z') },
      { status: 'failed', startedAt: at('2019-01-03T00:00:00Z') },
      // A run written by a future task that does populate the column.
      { status: 'succeeded', startedAt: at('2026-01-01T00:00:00Z'), terminalAt: at('2026-01-01T01:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // `ORDER BY "terminalAt" DESC` is NULLS FIRST in Postgres, so it puts the three 2019 failures
    // ahead of the 2026 success and answers 3 -- the default `consecutiveFailureLimit`, i.e. a
    // permanent halt on a workspace whose most recent run succeeded.
    expect(world.stats.consecutiveFailures).toBe(0)
  })
})

describe('loadWorld stats.activeRuns and stats.spentUsd', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('counts every non-terminal run, not just the first, and ignores terminal ones', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'working', startedAt: at('2026-01-01T00:00:00Z'), costUsd: 1.5 },
      { status: 'working', startedAt: at('2026-01-02T00:00:00Z'), costUsd: 2 },
      { status: 'working', startedAt: at('2026-01-03T00:00:00Z'), costUsd: 0.25 },
      { status: 'succeeded', startedAt: at('2026-01-04T00:00:00Z'), costUsd: 4 },
      { status: 'failed', startedAt: at('2026-01-05T00:00:00Z'), costUsd: 0.25 },
      { status: 'stopped', startedAt: at('2026-01-06T00:00:00Z'), costUsd: 2 },
    ])

    const { world } = await loadWorld(workspaceId(id))

    // `decide()` computes `slots = maxConcurrentRuns - activeRuns`; the arithmetic compounds an
    // error rather than clamping it, and over-counting slots spawns extra real `claude` processes.
    // Three concurrent runs, so a count that saturates at 1 (or that counts terminal rows too)
    // shows up here rather than in production.
    expect(world.stats.activeRuns).toBe(3)
    // Summed across every run regardless of status: a run that already finished still spent.
    expect(world.stats.spentUsd).toBeCloseTo(10)
  })

  it('reports zero spend rather than null when a workspace has no runs at all', async (): Promise<void> => {
    const id = await seedRuns([])

    const { world } = await loadWorld(workspaceId(id))
    expect(world.stats.activeRuns).toBe(0)
    expect(world.stats.spentUsd).toBe(0)
  })
})
