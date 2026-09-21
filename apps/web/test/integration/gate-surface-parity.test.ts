import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prisma } from '@slave-of-ai/db/client'
import {
  conversationCost,
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
import { COLUMN_FOR_STATUS } from '../../src/lib/taskColumns.js'
import { TABS, tabsFor } from '../../src/lib/routes.js'
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
 * surface it says it measures. One row is not a builder field at all: the header table's "stale
 * badge" is a client-side derivation from `goalVersion` columns (erratum E8), so it is pinned here
 * via those raw `workspace.goalVersion` / `task.goalVersion` columns rather than a builder's return
 * value.
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
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    const dev = await prisma.slave.create({ data: { teamId: team.id, role: 'Senior Engineer', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Dev' } })).id } })
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

  it("the view's settings ARE supervisorSettings(), plus F R4's runtime pair", async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { supervisorProvider: 'cursor', supervisorModel: 'auto' },
    })
    const view = await buildSupervisorView(workspaceId, new Date())
    const settings = await supervisorSettings(workspaceId)

    expect(settings).not.toBeNull()
    expect(settings?.enabled).toBe(true)
    // `supervisorSettings` is a THREE-column read and stays one -- it is on the tick's hot path,
    // asked a dozen times a second per project. The provider and the model the header's two
    // selects are bound to come off the same `Workspace` row beside it, so the view is that verb's
    // answer and nothing else, with the pair added.
    expect(view?.settings).toEqual({ ...settings, provider: 'cursor', model: 'auto' })
  })

  it("the conversation's cost so far IS conversationCost()", async (): Promise<void> => {
    await prisma.supervisorMessage.createMany({
      data: [
        { workspaceId, seq: 0, role: 'human', status: 'sent', text: 'what is stuck?' },
        { workspaceId, seq: 1, role: 'supervisor', status: 'answered', text: 'nothing', modelCostUsd: 0.75 },
        // A turn nobody could price (erratum E2): counted, never added up as a zero.
        { workspaceId, seq: 2, role: 'human', status: 'sent', text: 'and now?' },
        { workspaceId, seq: 3, role: 'supervisor', status: 'answered', text: 'still nothing', unmeasured: true },
      ],
    })

    const view = await buildSupervisorView(workspaceId, new Date())
    const cost = await conversationCost(workspaceId)

    expect(cost.usd).toBeCloseTo(0.75)
    expect(cost.unmeasuredTurns).toBe(1)
    expect(view?.conversationCostUsd).toBe(cost.usd)
    expect(view?.conversationUnmeasuredTurns).toBe(cost.unmeasuredTurns)
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

/**
 * M57 R10 / spec §5 stage 6: `scripts/gate-m57-ui-redesign.mjs` asserts that every card on the
 * board sits in the column `COLUMN_FOR_STATUS` says it should — and it cannot import that table,
 * for the reason this file's own header gives. So it re-declares it, and this case is the pin: the
 * gate's literal and the module must be the same thirteen pairs, or the gate is measuring a
 * vocabulary the board does not use.
 *
 * Parsed out of the gate's SOURCE rather than imported from it: the gate is a `.mjs` whose module
 * body drives a browser, and importing it would run it. The literal is a flat block of
 * `key: 'Value',` lines, which is all this needs to read.
 */
describe('the m57 gate reads the same task columns the board draws', () => {
  it('re-declares COLUMN_FOR_STATUS exactly', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../scripts/gate-m57-ui-redesign.mjs', import.meta.url)),
      'utf8',
    )
    const block = /const GATE_COLUMN_FOR_STATUS = \{([^}]*)\}/.exec(source)?.[1]
    expect(block, 'GATE_COLUMN_FOR_STATUS is not in the gate').toBeDefined()
    const parsed = Object.fromEntries(
      [...(block ?? '').matchAll(/^\s*(\w+):\s*'([^']+)',/gm)].map((match) => [match[1], match[2]]),
    )
    expect(parsed).toEqual(COLUMN_FOR_STATUS)
  })
})

describe('the m61 gate reads the same project tabs lib/routes.ts declares', () => {
  // `scripts/gate-m61-simple-mode.mjs` re-declares the six tab ids and the four simple ones,
  // for the reason the block above states about `COLUMN_FOR_STATUS`: `apps/web` compiles with
  // `noEmit: true` under a bundler resolver, so a plain `node` gate has nothing to import. This
  // is the pin -- a seventh tab, a reordering, or a tab moving between the modes fails here, in
  // the same commit that moved it.
  const source = readFileSync(
    fileURLToPath(new URL('../../../../scripts/gate-m61-simple-mode.mjs', import.meta.url)),
    'utf8',
  )

  function arrayIn(name: string): readonly string[] {
    const block = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)?.[1]
    expect(block, `${name} is not in the gate`).toBeDefined()
    return [...(block ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
  }

  it("TAB_IDS is TABS' own ids, in TABS' own order", () => {
    expect(arrayIn('TAB_IDS')).toEqual(TABS.map((tab) => tab.id))
  })

  it("SIMPLE_TAB_IDS is tabsFor('simple')", () => {
    expect(arrayIn('SIMPLE_TAB_IDS')).toEqual(tabsFor('simple').map((tab) => tab.id))
  })
})
