import { prisma } from '@slave-of-ai/db/client'
import {
  listDecisions,
  listGoalVersions,
  loadSupervisorWorld,
  setGoal,
  supervisorSettings,
  workspaceSpend,
} from '@slave-of-ai/control'
import { summarise } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildGoalHistory } from '../../src/server/goal.js'
import { buildOverviewSnapshot } from '../../src/server/overview.js'
import { RECENT_DECISION_LIMIT, buildSupervisorView } from '../../src/server/supervisor.js'
import { buildTasksSnapshot } from '../../src/server/tasks.js'

/**
 * M41 ruling R6 / erratum E9: `scripts/gate-m41-scenario.mjs` asserts the operator's surfaces
 * WITHOUT importing them. It cannot import them -- `apps/web` compiles with `noEmit: true` under
 * a bundler resolver, so there is no built output for a plain `node` script to load -- and it does
 * not need a control helper of its own either, because every field it reads is already a control
 * or domain verb the builders themselves compose.
 *
 * That claim is only true while it stays true. These cases are the pin: each one asserts that a
 * builder's field IS the verb the gate reads instead of it, and together they cover every row of
 * the gate header's mapping table. A builder that starts computing something of its own fails
 * here, and whoever changes it learns in the same commit that the gate has stopped measuring the
 * surface it says it measures.
 *
 * The world below is deliberately NOT empty (fix round 1, minor 4c). Two lists agreeing when both
 * are `[]` proves nothing: the fixture seeds a stuck task, an integrated one, a finished run with a
 * real cost, and two decisions -- one still waiting on a human, one a person already resolved -- so
 * `report`, `pending`, `recent` and `spentUsd` are all compared over rows that exist.
 *
 * This file lives under `test/integration/` rather than beside the unit tests, because it reads
 * the real builders against a real database: the `unit` vitest project runs without
 * `test-setup/require-database.ts`, so `DATABASE_URL` is never pointed at the test database there
 * and every Prisma call in this file would reach for whatever the ambient environment happens to
 * name. The brief's own path put it one directory up; the mapping it pins is the same either way.
 */
describe('the gate reads the same facts the web builders publish', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    // The house idiom, copied from `tasks-snapshot.test.ts` and its siblings: `CASCADE` reaches
    // `SupervisorDecision`, `GoalVersion` and `RunContext` through their FKs to the tables named
    // here, so nothing this fixture writes outlives the run.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    const workspace = await prisma.workspace.create({
      data: {
        name: 'M41 Parity Project',
        repoPath: '/tmp/m41-parity-does-not-need-to-exist',
        baseBranch: 'main',
        autoMerge: false,
        verifyCommands: ['true'],
        setupCommands: [],
        maxAttempts: 5,
      },
    })
    workspaceId = workspace.id
    const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
    const dev = await prisma.slave.create({
      data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    expect((await setGoal(workspaceId, 'Ship the thing')).ok).toBe(true)
    await prisma.task.create({
      data: { workspaceId, title: 'One', description: 'a task', status: 'ready', requiredRole: 'backend', maxAttempts: 5, goalVersion: 1 },
    })
    // Two stuck tasks, so `report.stuck` and `report.next.blocked` are not zero -- and so each
    // seeded decision below has a subject of its own rather than a made-up key.
    const park = (title: string): Promise<{ readonly id: string }> =>
      prisma.task.create({
        data: { workspaceId, title, description: 'a parked task', status: 'blocked', requiredRole: 'backend', maxAttempts: 5, goalVersion: 1 },
      })
    const [parkedTwo, parkedThree] = await Promise.all([park('Two'), park('Three')])
    // A finished, integrated task, so `report.done` and the overview's `done` count are not zero.
    const done = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Four',
        description: 'finished work',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 5,
        goalVersion: 1,
        branch: 'slaveofai/T-four',
        integratedAt: new Date(),
      },
    })
    // A concluded run with a real cost, so `workspaceSpend().spentUsd` is a number worth comparing.
    await prisma.slaveRun.create({
      data: {
        taskId: done.id,
        slaveId: dev.id,
        kind: 'implementation',
        status: 'succeeded',
        costUsd: 0.25,
        startedAt: new Date(),
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await seedDecision('pending', parkedTwo.id)
    await seedDecision('approved', parkedThree.id)
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  /** One stored decision about the blocked task: `pending` is what a human still owes an answer to,
   *  `approved` is one they already resolved. Both are written in the shape `recordDecision` writes
   *  and `listDecisions` reads back through `situationSchema`/`candidateSchema`/`actionSchema`. */
  async function seedDecision(status: 'pending' | 'approved', taskId: string): Promise<void> {
    const action = { kind: 'unblock_task', taskId } as const
    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'task_blocked_human',
        subjectId: taskId,
        situation: {
          kind: 'task_blocked_human',
          subjectId: taskId,
          summary: 'The task is blocked and nothing but a human decision moves it.',
          facts: { taskId, status: 'blocked', attempt: 1 },
        },
        candidates: [{ action, tier: 'proposed', why: 'An operator can let it try again.' }],
        chosenIndex: 0,
        action,
        rationale: `seeded ${status}`,
        tier: 'proposed',
        status,
        decidedBy: 'rules',
        modelCalled: false,
        ...(status === 'approved' ? { resolvedAt: new Date() } : {}),
      },
    })
  }

  it("the Supervisor view's report IS summarise() over loadSupervisorWorld()'s world", async (): Promise<void> => {
    const now = new Date()
    const view = await buildSupervisorView(workspaceId, now)
    const loaded = await loadSupervisorWorld(workspaceId, now)
    const report = summarise(loaded.world)

    expect(view).not.toBeNull()
    // The fixture really does put something in every list this compares, so an accidental `[]`
    // on either side cannot pass as agreement.
    expect(report.stuck.length).toBeGreaterThan(0)
    expect(report.done.integrated).toBeGreaterThan(0)
    expect(report.supervisor.pending).toBeGreaterThan(0)
    expect(view?.report).toEqual(report)
    expect(view?.questions.length).toBe(loaded.world.questions.length)
  })

  it("the view's pending and recent decision lists ARE listDecisions()", async (): Promise<void> => {
    const view = await buildSupervisorView(workspaceId, new Date())
    const pending = await listDecisions(workspaceId, { pending: true })
    const recent = await listDecisions(workspaceId, { limit: RECENT_DECISION_LIMIT })

    expect(pending.length).toBe(1)
    expect(pending[0]?.status).toBe('pending')
    expect(recent.length).toBe(2)
    expect(view?.pending).toEqual(pending)
    expect(view?.recent).toEqual(recent)
    // The gate reads the recent list through the verb's own default limit, which is the header
    // table's `listDecisions(id)`. That is the same list for as long as a project has fewer
    // decisions than `RECENT_DECISION_LIMIT`, and this asserts the two do not diverge below it.
    expect(recent).toEqual(await listDecisions(workspaceId))
  })

  it("the view's settings ARE supervisorSettings()", async (): Promise<void> => {
    const view = await buildSupervisorView(workspaceId, new Date())
    const settings = await supervisorSettings(workspaceId)

    expect(settings).not.toBeNull()
    expect(settings?.enabled).toBe(true)
    expect(view?.settings).toEqual(settings)
  })

  it('the goal history IS listGoalVersions()', async (): Promise<void> => {
    const history = await buildGoalHistory(workspaceId)
    const versions = await listGoalVersions(workspaceId)

    expect(versions.ok).toBe(true)
    expect(history).toEqual(versions.ok ? versions.value : null)
  })

  it('the tasks snapshot publishes the Task and Workspace columns unchanged', async (): Promise<void> => {
    const snapshot = await buildTasksSnapshot(workspaceId)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const tasks = await prisma.task.findMany({ where: { workspaceId }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] })

    expect(snapshot?.workspace.goalVersion).toBe(workspace.goalVersion)
    expect(snapshot?.tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt])).toEqual(
      tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt === null ? null : one.integratedAt.toISOString()]),
    )
    // The `integratedAt` column is what the gate's truth table reads as "integrated", so at least
    // one row here has to carry a real one.
    expect(snapshot?.tasks.filter((one) => one.integratedAt !== null).length).toBe(1)
  })

  it("the overview's task counts are the board counted by status, and its spend IS workspaceSpend()", async (): Promise<void> => {
    const snapshot = await buildOverviewSnapshot(workspaceId)
    const tasks = await prisma.task.findMany({ where: { workspaceId } })
    const spend = await workspaceSpend(workspaceId)

    const countOf = (statuses: readonly string[]): number => tasks.filter((one) => statuses.includes(one.status)).length
    expect(snapshot?.tasks.ready).toBe(countOf(['ready']))
    expect(snapshot?.tasks.done).toBe(countOf(['done']))
    expect(snapshot?.tasks.failed).toBe(countOf(['failed']))
    expect(snapshot?.tasks.blocked).toBe(countOf(['blocked']))
    expect(spend.spentUsd).toBeGreaterThan(0)
    expect(snapshot?.workspace.spentUsd).toBe(spend.spentUsd)
  })
})
