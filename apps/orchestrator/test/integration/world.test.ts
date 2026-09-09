import { SUPERVISOR_PER_CALL_CAP_USD, decide, slaveId, taskId, workspaceId } from '@slave-of-ai/domain'
import { workspaceStats } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadWorld } from '../../src/world.js'

/**
 * One teardown for the file, not one per `describe`. A describe-scoped `afterAll` fires when that
 * block finishes, so disconnecting there tears down the client the later blocks still need --
 * Prisma reconnects lazily so it happens to work, which is exactly what makes it worth stating.
 */
afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

/**
 * One workspace wired up to exercise every branch `loadWorld` has to get right:
 *
 *  - `doneDep` -> `readyTask` -> `blockedTask` is a two-hop dependency chain, done at the near
 *    end and unsatisfied at the far end, so the "every dependency done" SQL has to walk past a
 *    single vacuously-true case (`doneDep` itself has no dependencies) to prove it isn't just
 *    returning true unconditionally.
 *  - `roleless` has no `requiredRole` -- the one case spec §4 says gets excluded from the
 *    schedulable set and counted, not silently dropped.
 *  - `slaveWithRun` holds a `working` (non-terminal) run, `idleSlave` holds none, and
 *    `retiredRunSlave` holds a `succeeded` (terminal) one -- so "busy" can't be satisfied by
 *    "has ever had a run".
 */
interface Fixture {
  readonly workspaceId: string
  readonly doneDepTaskId: string
  readonly readyTaskId: string
  readonly blockedTaskId: string
  readonly rolelessTaskId: string
  readonly slaveWithRunId: string
  readonly idleSlaveId: string
  readonly retiredRunSlaveId: string
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

  const slaveWithRun = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
  })
  const idleSlave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Blair', role: 'backend', runtimeRoles: ['backend'] },
  })
  const retiredRunSlave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Casey', role: 'backend', runtimeRoles: ['backend'] },
  })

  const doneDep = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'doneDep',
      description: 'already merged',
      status: 'done',
      // M35 t2: `done` alone no longer satisfies the gate -- this fixture's whole point is a
      // dependency that genuinely IS satisfied, so it must carry the stamp too.
      integratedAt: new Date(),
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
  await prisma.slaveRun.create({
    data: { taskId: workingTask.id, slaveId: slaveWithRun.id, status: 'working' },
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
  await prisma.slaveRun.create({
    data: { taskId: doneRunTask.id, slaveId: retiredRunSlave.id, status: 'succeeded' },
  })

  return {
    workspaceId: workspace.id,
    doneDepTaskId: doneDep.id,
    readyTaskId: readyTask.id,
    blockedTaskId: blockedTask.id,
    rolelessTaskId: rolelessTask.id,
    slaveWithRunId: slaveWithRun.id,
    idleSlaveId: idleSlave.id,
    retiredRunSlaveId: retiredRunSlave.id,
  }
}

describe('loadWorld', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seedFixture()
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

  it('M35 t2: a done-but-unintegrated dependency does NOT satisfy the gate, only status=done AND integratedAt does', async (): Promise<void> => {
    // `doneDep` is `done` with no stamp -- the `!autoMerge` shape: reviewed, but its branch and
    // worktree are still sitting there for a human. Its own single dependent (`readyTask`) must
    // stay gated until it is.
    await prisma.task.update({ where: { id: fixture.doneDepTaskId }, data: { integratedAt: null } })

    const before = await loadWorld(workspaceId(fixture.workspaceId))
    const readyBefore = before.world.tasks.find((t) => t.id === taskId(fixture.readyTaskId))
    expect(readyBefore?.dependenciesDone).toBe(false)

    // The stamp alone -- status stays `done`, nothing else about the row changes -- flips the gate.
    await prisma.task.update({ where: { id: fixture.doneDepTaskId }, data: { integratedAt: new Date() } })

    const after = await loadWorld(workspaceId(fixture.workspaceId))
    const readyAfter = after.world.tasks.find((t) => t.id === taskId(fixture.readyTaskId))
    expect(readyAfter?.dependenciesDone).toBe(true)
  })

  it('counts tasks with no required role instead of silently dropping them', async (): Promise<void> => {
    const { world, skippedNoRole } = await loadWorld(workspaceId(fixture.workspaceId))

    expect(world.tasks.some((t) => t.id === taskId(fixture.rolelessTaskId))).toBe(false)
    expect(skippedNoRole).toBe(1)
  })

  it('reports a slave busy only while it holds a non-terminal run', async (): Promise<void> => {
    const { world } = await loadWorld(workspaceId(fixture.workspaceId))

    expect(world.slaves.find((a) => a.id === slaveId(fixture.slaveWithRunId))?.busy).toBe(true)
    expect(world.slaves.find((a) => a.id === slaveId(fixture.idleSlaveId))?.busy).toBe(false)
    // Held a run once, but it finished. "Busy" can't be implemented as "has any SlaveRun row" --
    // that would trap a slave as permanently busy after its first completed run.
    expect(world.slaves.find((a) => a.id === slaveId(fixture.retiredRunSlaveId))?.busy).toBe(false)
  })

  // M37 t3: the world carries `runtimeRoles` and not `Slave.role` -- `decide()` matches
  // `Task.requiredRole` against the set, so a title that happens to read "backend" must not be
  // able to stand in for a role an operator never granted, and a set that names the role must work
  // whatever the title says.
  it('carries each slave\'s runtimeRoles, not its title', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const titled = await prisma.slave.create({
      data: { teamId: team.id, name: 'Senior', role: 'backend', runtimeRoles: ['reviewer'] },
    })
    const parked = await prisma.slave.create({
      data: { teamId: team.id, name: 'Parked', role: 'backend', runtimeRoles: [] },
    })

    const { world } = await loadWorld(workspaceId(fixture.workspaceId))

    expect(world.slaves.find((a) => a.id === slaveId(titled.id))?.runtimeRoles).toEqual(['reviewer'])
    expect(world.slaves.find((a) => a.id === slaveId(parked.id))?.runtimeRoles).toEqual([])
    // And the scheduler acts on it: neither of the two is a candidate for a `backend` task, even
    // though `Slave.role` says "backend" on both.
    const commands = decide({
      ...world,
      slaves: world.slaves.filter((a) => a.id === slaveId(titled.id) || a.id === slaveId(parked.id)),
    })
    expect(commands).toEqual([])
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
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Dana', role: 'backend', runtimeRoles: ['backend'] },
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
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: slave.id,
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
      'TRUNCATE TABLE "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
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

  it('still trips the breaker when far more concluded runs exist than the bounded query reads', async (): Promise<void> => {
    // `workspaceStats` reads only `consecutiveFailureLimit + 1` concluded runs (final review
    // Important 2). Eight runs here, five of them a live failure streak, against the default limit
    // of 3: the query sees four rows, all failures, and the breaker has to trip on that prefix.
    // The three successes behind them exist precisely so the bound is what stops them being read.
    const id = await seedRuns([
      { status: 'succeeded', startedAt: at('2026-01-01T00:00:00Z') },
      { status: 'succeeded', startedAt: at('2026-01-02T00:00:00Z') },
      { status: 'succeeded', startedAt: at('2026-01-03T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-04T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-05T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-06T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-07T00:00:00Z') },
      { status: 'failed', startedAt: at('2026-01-08T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // Four, not five: the reported figure is the streak AS FAR AS THE WINDOW SEES IT, which is the
    // documented contract. What has to hold is the comparison the guardrail makes.
    expect(world.stats.consecutiveFailures).toBe(world.limits.consecutiveFailureLimit + 1)
    expect(world.stats.consecutiveFailures >= world.limits.consecutiveFailureLimit).toBe(true)
    expect(decide(world)).toEqual([{ kind: 'halt', reason: 'circuit_breaker' }])
  })

  it('orders by conclusion rather than start when the two disagree', async (): Promise<void> => {
    const id = await seedRuns([
      // A long run: started first, concluded last.
      { status: 'failed', startedAt: at('2026-01-01T00:00:00Z'), terminalAt: at('2026-06-01T00:00:00Z') },
      // A short run that started after it but finished long before it.
      { status: 'succeeded', startedAt: at('2026-02-01T00:00:00Z'), terminalAt: at('2026-03-01T00:00:00Z') },
    ])

    const { world } = await loadWorld(workspaceId(id))
    // The failure is the workspace's most recently *concluded* run, so the streak is 1. Ordering
    // on `startedAt` alone answers 0 -- and that is the whole content of the `COALESCE`: the case
    // above pins only its fallback half, which `ORDER BY "startedAt" DESC` satisfies just as well.
    // Without this case, deleting `terminalAt` from the sort key passes the suite.
    expect(world.stats.consecutiveFailures).toBe(1)
  })
})

describe('loadWorld stats.activeRuns and stats.spentUsd', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
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
    // `toBe`, not `toBeCloseTo`: every addend here is a dyadic rational and so is every partial
    // sum, so binary64 represents the total exactly. A tolerance would be covering for nothing and
    // would quietly weaken the assertion.
    expect(world.stats.spentUsd).toBe(10)
  })

  /**
   * M38 §5: a Supervisor model call is workspace spend. Without this the budget guardrail would
   * watch only the runs, and a Supervisor could keep deciding -- one model call at a time -- long
   * after the money it was given had run out.
   */
  it('adds the Supervisor\'s measured decisions and charges every unmeasured call at the cap', async (): Promise<void> => {
    const id = await seedRuns([{ status: 'succeeded', startedAt: at('2026-01-01T00:00:00Z'), costUsd: 2 }])
    const decision = {
      workspaceId: id,
      situationKind: 'review_cap_blocked' as const,
      subjectId: 'task-1',
      situation: {},
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'x',
      tier: 'noop' as const,
      status: 'applied' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: 0.25 },
    })
    // The call happened and its cost never came back: charged at the cap, never at zero.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: null },
    })
    // Erratum E6: the call happened, came back unusable, and the RULES chose -- the money was
    // still spent, so this is charged at the cap exactly like the row above. Keying the charge on
    // `decidedBy` (as this did before the fix round) missed precisely this case, which is also the
    // case a provider is most likely to report no cost for.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: true, modelCostUsd: null },
    })
    // A rules decision that called nobody adds nothing at all.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: false, modelCostUsd: null },
    })

    const { world, supervisorSpend, statsSnapshot } = await loadWorld(workspaceId(id))

    expect(world.stats.spentUsd).toBe(2 + 0.25 + 2 * SUPERVISOR_PER_CALL_CAP_USD)
    expect(supervisorSpend).toEqual({ measuredUsd: 0.25, unmeasuredCalls: 2 })
    // M39 §4: the reading itself is handed on, so the tick's Supervisor pass can decide from it
    // instead of paying for a second one. It is the SAME numbers `decide()` just saw.
    expect(statsSnapshot.limits).toBe(world.limits)
    expect(statsSnapshot.stats).toBe(world.stats)
    expect(statsSnapshot.spend).toEqual({
      runsMeasuredUsd: 2,
      supervisorMeasuredUsd: 0.25,
      supervisorUnmeasuredCalls: 2,
      spentUsd: 2 + 0.25 + 2 * SUPERVISOR_PER_CALL_CAP_USD,
    })
  })

  /**
   * Erratum E7: `loadWorld`'s limits and stats now come from control's `workspaceStats`, the same
   * helper `loadSupervisorWorld` reads, so the halt the scheduler acts on and the halt the
   * Supervisor sees cannot be two different halts. This is the parity assertion for that move --
   * the helper must return exactly what `loadWorld` puts in front of `decide()`.
   */
  it('reads its limits and stats from the same control helper the Supervisor does', async (): Promise<void> => {
    const id = await seedRuns([
      { status: 'working', startedAt: at('2026-01-01T00:00:00Z'), costUsd: 1 },
      { status: 'failed', startedAt: at('2026-01-02T00:00:00Z'), terminalAt: at('2026-01-02T01:00:00Z'), costUsd: 2 },
    ])

    const { world } = await loadWorld(workspaceId(id))
    const snapshot = await workspaceStats(id)

    expect(snapshot.stats).toEqual(world.stats)
    expect(snapshot.limits).toEqual(world.limits)
  })

  it('reports zero spend rather than null when a workspace has no runs at all', async (): Promise<void> => {
    const id = await seedRuns([])

    const { world } = await loadWorld(workspaceId(id))
    expect(world.stats.activeRuns).toBe(0)
    expect(world.stats.spentUsd).toBe(0)
  })

  /**
   * A planning run (Task 6) has no `Task` row -- `taskId` is `null` -- so its only linkage to a
   * workspace is `slave -> team -> workspace`. Every query this file exercises above joins through
   * `Task` instead, and a task-less run would silently vanish from both a workspace's concurrency
   * slot count and its spend total: it looks idle and free while a real process burns real money.
   * Seeded directly (no factory creates a task-less run yet) because nothing else in this
   * milestone does either.
   */
  it('counts a task-less planning run in activeRuns and its cost in spentUsd', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Planning Workspace',
        repoPath: '/tmp/planning',
        verifyCommands: ['npm test'],
        setupCommands: ['npm ci'],
      },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Planner', role: 'planner', runtimeRoles: ['planner'] } })
    await prisma.slaveRun.create({
      data: { slaveId: slave.id, kind: 'planning', status: 'working', costUsd: 2.5 },
    })

    const { world } = await loadWorld(workspaceId(workspace.id))
    expect(world.stats.activeRuns).toBe(1)
    expect(world.stats.spentUsd).toBe(2.5)
  })
})

/**
 * `stats.globalActiveRuns` (spec §5) counts non-terminal `SlaveRun`s across every workspace, not
 * just the one `loadWorld` was asked about -- it feeds a cross-workspace guardrail, so a second
 * workspace's runs must be visible here even though nothing else this file loads ever crosses a
 * workspace boundary.
 */
describe('loadWorld stats.globalActiveRuns', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('counts non-terminal runs across all workspaces while activeRuns stays scoped to one', async (): Promise<void> => {
    const fixture = await seedFixture()

    const otherWorkspace = await prisma.workspace.create({
      data: {
        name: 'Other Workspace',
        repoPath: '/tmp/other',
        verifyCommands: ['npm test'],
        setupCommands: ['npm ci'],
      },
    })
    const otherTeam = await prisma.team.create({
      data: { workspaceId: otherWorkspace.id, name: 'Other Team' },
    })
    const otherSlave = await prisma.slave.create({
      data: { teamId: otherTeam.id, name: 'Other Slave', role: 'backend', runtimeRoles: ['backend'] },
    })
    const otherTask = await prisma.task.create({
      data: {
        workspaceId: otherWorkspace.id,
        title: 'otherTask',
        description: 'hosts a run in a different workspace',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: otherWorkspace.maxAttempts,
      },
    })
    await prisma.slaveRun.create({
      data: { taskId: otherTask.id, slaveId: otherSlave.id, status: 'working' },
    })

    const { world } = await loadWorld(workspaceId(fixture.workspaceId))

    // The fixture workspace's own non-terminal run plus the other workspace's: both count toward
    // the global figure, but only the fixture's own counts toward the scoped one.
    expect(world.stats.activeRuns).toBe(1)
    expect(world.stats.globalActiveRuns).toBe(2)
  })

  it('exposes the global concurrency limit as a fixed constant, not a Workspace column', async (): Promise<void> => {
    const fixture = await seedFixture()

    const { world } = await loadWorld(workspaceId(fixture.workspaceId))
    expect(world.limits.maxGlobalConcurrentRuns).toBe(6)
  })
})
