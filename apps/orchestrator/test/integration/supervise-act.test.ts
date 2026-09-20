import { loadSupervisorWorld, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { candidates, observe } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { supervise } from '../../src/supervisor.js'

/**
 * The whole switch, end to end (spec §5): a project the second maratus run left exactly as this
 * fixture seeds it, driven through the ORCHESTRATOR's own `supervise` under `supervisorAutonomy:
 * 'act'` until it is running again with nobody asked for anything.
 *
 * Every other test in this milestone proves one joint -- `tierOf`'s table, `candidates`' offers,
 * `carryOut`'s verbs, the loader's two queries. This one proves they meet: the world is loaded by
 * `loadSupervisorWorld` from real rows, the situations come from `observe`, the catalogue from
 * `candidates`, the tier from `tierOf`, and the remedy reaches the database through
 * `applyDecision` -> `carryOut` -> `retryTask`. Nothing here is stubbed but the model, which
 * answers with an index exactly as the fake CLI's `supervisor-decision` fixture does.
 *
 * The scenario is 2026-09-20's, fact for fact: a research task whose runs were refused
 * `network_fetch`, three failed implementation runs in a row, and the circuit breaker holding the
 * whole project still. Three passes, one clock each (a second pass on the same instant would be
 * inside `COOLDOWN_MS` and decide nothing):
 *
 *  1. the failed task is diagnosed, granted the operation it was refused, and put back to `rework`;
 *  2. the halt, whose cause is now answered, is retracted;
 *  3. a SECOND runaway inside the hour is not retracted -- a person is asked.
 */

const PASS_1 = new Date('2026-09-20T12:00:00.000Z')
const PASS_2 = new Date('2026-09-20T12:16:00.000Z')
const PASS_3 = new Date('2026-09-20T12:32:00.000Z')

const ago = (from: Date, ms: number): Date => new Date(from.getTime() - ms)

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
  readonly dependentId: string
  readonly runId: string
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlavePermission", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

/** The model seam the daemon wires, answering the first candidate -- `candidates` puts the remedy
 *  first, which is the contract the fake CLI's `supervisor-decision` fixture is written against. */
function firstCandidate(): { readonly decider: ModelDecider; readonly prompts: string[] } {
  const prompts: string[] = []
  const answer: ModelOutcome = {
    kind: 'answer',
    text: '{"candidateIndex": 0, "rationale": "the refusal is the whole cause, and one decision answers it"}',
    costUsd: 0.01,
    tokens: { input: 100, output: 20 },
    numTurns: 1,
  }
  return {
    decider: (input) => {
      prompts.push(input.prompt)
      return Promise.resolve(answer)
    },
    prompts,
  }
}

/** One failed implementation run, concluded at `at`. The breaker counts these. */
async function failedRun(fixture: { taskId: string; slaveId: string }, at: Date): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      kind: 'implementation',
      status: 'failed',
      startedAt: ago(at, 20 * 60_000),
      terminalAt: at,
    },
  })
  return run.id
}

/**
 * The project as the second maratus run left it.
 *
 * A research seat with no `network_fetch` row of its own (the operation is baseline for nothing),
 * a `failed` research task with one dependent waiting on it, and three failed implementation runs
 * whose last one recorded both halves of the diagnosis: the refusal that stopped the work, and the
 * reason line the run died on. The workspace's own `haltedReason` stays NULL on purpose -- a
 * breaker halt is DERIVED (`evaluateGuardrails` over the streak), and deriving it here is what
 * makes this a test of the halt the product actually produces.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Maratus',
      repoPath: '/tmp/maratus',
      verifyCommands: ['npm test'],
      setupCommands: [],
      supervisorAutonomy: 'act',
      autoMerge: true,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Growth' } })
  const person = await prisma.person.create({ data: { name: 'Robin' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, personId: person.id, role: 'research', runtimeRoles: ['research'] },
  })

  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Read the market',
      description: 'find out who else sells this',
      status: 'failed',
      requiredRole: 'research',
      attempt: 3,
      maxAttempts: 3,
    },
  })
  const dependent = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Write the positioning',
      description: 'from what the research found',
      status: 'backlog',
      requiredRole: 'marketing',
      maxAttempts: 3,
    },
  })
  await prisma.taskDependency.create({ data: { taskId: dependent.id, dependsOnTaskId: task.id } })

  const runs = [
    await failedRun({ taskId: task.id, slaveId: slave.id }, ago(PASS_1, 3 * 3_600_000)),
    await failedRun({ taskId: task.id, slaveId: slave.id }, ago(PASS_1, 2 * 3_600_000)),
    await failedRun({ taskId: task.id, slaveId: slave.id }, ago(PASS_1, 3_600_000)),
  ]
  const runId = runs[2] ?? ''

  await prisma.executionEvent.create({
    data: {
      workspaceId: workspace.id,
      taskId: task.id,
      slaveId: slave.id,
      runId,
      type: 'run_tool_denied',
      // The actors the pump itself writes: the worker met the wall, the system concluded the run.
      actor: 'slave',
      payload: { tool: 'WebFetch', capability: 'network_fetch', toolUseId: 'tu-1' },
      ts: ago(PASS_1, 3_600_000 + 60_000),
    },
  })
  await prisma.executionEvent.create({
    data: {
      workspaceId: workspace.id,
      taskId: task.id,
      slaveId: slave.id,
      runId,
      type: 'run_failed',
      actor: 'system',
      // Both readings are on this one line: the run died lost ("output stream ended"), and it was
      // refused an operation. The refusal wins (erratum E4) -- it is the more specific fact, and
      // the one a remedy can act on.
      payload: { reason: "the run's output stream ended without a terminal result" },
      ts: ago(PASS_1, 3_600_000),
    },
  })

  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id, dependentId: dependent.id, runId }
}

const decisions = (workspaceId: string) =>
  prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

const appliedEvents = (workspaceId: string) =>
  prisma.executionEvent.findMany({ where: { workspaceId, type: 'supervisor_applied' }, orderBy: { seq: 'asc' } })

describe('the self-running project, end to end under act', () => {
  beforeEach(reset)

  it('diagnoses the refusal, grants the operation, retries the task, and then clears the halt it caused', async () => {
    const fixture = await seed()
    const model = firstCandidate()

    // The halt is real and DERIVED before anything is decided: three failed runs in a row, nothing
    // in the project's own columns.
    const before = await loadSupervisorWorld(fixture.workspaceId, PASS_1)
    expect(before.world.halted).toEqual({ reason: 'circuit_breaker' })
    expect(before.world.autonomy).toBe('act')
    expect(before.world.tasks.find((one) => one.id === fixture.taskId)).toMatchObject({
      status: 'failed',
      deniedKinds: ['network_fetch'],
      failureCount: 3,
      retries: 0,
    })

    // ---- Pass 1: the task comes back, with the operation it was refused --------------------
    const first = await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_1,
    })
    // Two situations were free to decide and exactly ONE was: the halt is the last kind
    // `observe` emits and this pass has just remedied its cause, so it is left for the next pass,
    // which reads a world that knows about the retry (erratum E12). `rulesOnly` because a halted
    // workspace is never thought about with money -- the rules carried the whole remedy, and the
    // model the daemon wires was not asked.
    expect(first).toEqual({
      situations: 2,
      decided: 1,
      applied: 1,
      proposed: 0,
      skippedCooldown: 0,
      modelCalls: 0,
      rulesOnly: true,
      answered: 0,
      drafted: 0,
      pruned: 0,
    })
    expect(model.prompts).toHaveLength(0)

    const retried = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(retried.status).toBe('rework')
    expect(retried.attempt).toBe(0)
    expect(retried.retries).toBe(1)
    expect(retried.activeRunId).toBeNull()
    // The note the next run reads, in the system's own words -- no model wrote this sentence.
    expect(retried.lastRejectionReason).toContain('refused')

    const granted = await prisma.slavePermission.findFirstOrThrow({
      where: { slaveId: fixture.slaveId, kind: 'network_fetch' },
    })
    expect(granted.mode).toBe('allow')

    const retryDecision = (await decisions(fixture.workspaceId)).find(
      (row) => (row.action as { kind?: string }).kind === 'retry_task',
    )
    expect(retryDecision?.status).toBe('applied')
    expect(retryDecision?.tier).toBe('applied')
    expect(retryDecision?.situation).toMatchObject({ kind: 'task_failed', subjectId: fixture.taskId })
    // R8/erratum E9: the feed's row is built from this payload, so the whole action rides on it.
    const appliedRetry = (await appliedEvents(fixture.workspaceId)).find(
      (row) => (row.payload as { action?: { kind?: string } }).action?.kind === 'retry_task',
    )
    expect(appliedRetry?.payload).toMatchObject({
      action: {
        kind: 'retry_task',
        taskId: fixture.taskId,
        title: 'Read the market',
        grant: { slaveId: fixture.slaveId, permissionKind: 'network_fetch' },
      },
    })
    // Nobody was asked anything: no escalation, and nothing left pending.
    expect((await decisions(fixture.workspaceId)).filter((row) => row.status === 'pending')).toHaveLength(0)

    // ---- Pass 2: the halt is retracted, because its cause has been answered ----------------
    const second = await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_2,
    })
    // One situation, one decision, carried out. `task_failed` is gone -- the task is `rework` now --
    // and the halt is the only thing left to answer.
    expect(second).toMatchObject({ situations: 1, decided: 1, applied: 1, proposed: 0, modelCalls: 0 })

    const cleared = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(cleared.haltClearedAt).not.toBeNull()
    const clearDecision = (await decisions(fixture.workspaceId)).find(
      (row) => (row.action as { kind?: string }).kind === 'clear_halt',
    )
    expect(clearDecision?.status).toBe('applied')
    expect(clearDecision?.tier).toBe('applied')

    // The halt is gone from the TICK's own view of the world: the streak the breaker counted is
    // behind `haltClearedAt`, so the next tick schedules the task the retry put back.
    const after = await loadSupervisorWorld(fixture.workspaceId, PASS_2)
    expect(after.world.halted).toBeNull()
    expect(after.world.tasks.find((one) => one.id === fixture.taskId)?.status).toBe('rework')

    // Not one human verb was called on the way: every decision this project made was carried out
    // by the Supervisor itself, and none of them is an escalation.
    const all = await decisions(fixture.workspaceId)
    expect(all.filter((row) => row.tier === 'escalated')).toHaveLength(0)
    expect(all.every((row) => row.status === 'applied')).toBe(true)
  })

  /**
   * The OTHER half of the switch, and the one the two cases above cannot reach (final review,
   * recommendation 6): a failed task on a project the breaker never stopped.
   *
   * Both cases above run on a halted world, where `supervise` withholds the model seam entirely --
   * `rulesOnly: true`, no prompt, no call. So every end-to-end assertion this file made about the
   * MODEL path was made about a pass that never opened it, and the daemon's ordinary shape on
   * `act` (a decider wired, a budget, nothing halted) had no test of its own. Here the seam is
   * open, the model is asked, and its answer -- the fake CLI's own `{"candidateIndex": 0}` -- is
   * what gets carried out.
   */
  it('asks the model and carries out its answer on a project the breaker never stopped', async () => {
    const fixture = await seed()
    const model = firstCandidate()

    // ONE failed run instead of three: `consecutiveFailureLimit` is 3, so the streak that halted
    // the other two cases never forms and the project is merely a project with a failed task on it.
    await prisma.slaveRun.deleteMany({ where: { taskId: fixture.taskId, id: { not: fixture.runId } } })

    const before = await loadSupervisorWorld(fixture.workspaceId, PASS_1)
    expect(before.world.halted).toBeNull()
    expect(before.world.autonomy).toBe('act')

    const pass = await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_1,
    })
    // The seam was open and it was used: one call, one prompt, and the pass is not rules-only.
    expect(pass).toMatchObject({ situations: 1, decided: 1, applied: 1, proposed: 0, modelCalls: 1, rulesOnly: false })
    expect(model.prompts).toHaveLength(1)

    const decision = (await decisions(fixture.workspaceId)).find(
      (row) => (row.action as { kind?: string }).kind === 'retry_task',
    )
    expect(decision?.status).toBe('applied')
    expect(decision?.tier).toBe('applied')
    // The MODEL chose it -- `chooseByRules` records `rules`, and that is the distinction this case
    // exists to make.
    expect(decision?.decidedBy).toBe('model')

    const retried = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(retried.status).toBe('rework')
    expect(retried.attempt).toBe(0)
    expect(retried.retries).toBe(1)
    expect(
      (await prisma.slavePermission.findUniqueOrThrow({
        where: { slaveId_kind: { slaveId: fixture.slaveId, kind: 'network_fetch' } },
      })).mode,
    ).toBe('allow')
    // Nobody was asked anything, and nothing is waiting.
    const all = await decisions(fixture.workspaceId)
    expect(all.filter((row) => row.status === 'pending' || row.tier === 'escalated')).toHaveLength(0)
  })

  it('does not clear a second halt inside the hour: the candidate set holds no clear_halt, and a person is asked', async () => {
    const fixture = await seed()
    const model = firstCandidate()

    await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_1,
    })
    await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_2,
    })

    // A SECOND runaway, ten minutes after the halt was cleared: three more failed runs, all of them
    // after the stamp, so the breaker counts them and halts the project again.
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltClearedAt: ago(PASS_3, 10 * 60_000) },
    })
    for (const minutes of [8, 6, 4]) {
      await failedRun({ taskId: fixture.taskId, slaveId: fixture.slaveId }, ago(PASS_3, minutes * 60_000))
    }

    const world = await loadSupervisorWorld(fixture.workspaceId, PASS_3)
    expect(world.world.halted).toEqual({ reason: 'circuit_breaker' })

    // The catalogue itself, not merely what was chosen from it: the remedy is NOT on the menu, so
    // there is nothing for a model or a rule to pick.
    const halted = observe(world.world).find((one) => one.kind === 'workspace_halted')
    expect(halted).toBeDefined()
    const menu = candidates(halted!, world.world).map((one) => one.action.kind)
    expect(menu).not.toContain('clear_halt')
    expect(menu).toContain('escalate_to_human')

    const third = await supervise({
      workspaceId: fixture.workspaceId,
      decider: model.decider,
      model: 'claude-sonnet-5',
      now: () => PASS_3,
    })
    expect(third.proposed).toBeGreaterThanOrEqual(1)

    const haltDecisions = (await decisions(fixture.workspaceId)).filter(
      (row) => (row.situation as { kind?: string }).kind === 'workspace_halted',
    )
    const latest = haltDecisions.at(-1)
    expect((latest?.action as { kind?: string }).kind).toBe('escalate_to_human')
    expect(latest?.tier).toBe('escalated')
    // And the halt stands: nothing retracted it.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).haltClearedAt?.getTime()).toBe(
      ago(PASS_3, 10 * 60_000).getTime(),
    )
  })
})
