import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adoptRunbook,
  refusalText,
  runbookStatus,
  setGoal,
  syncCapabilityTaxonomy,
  syncRunbooks,
} from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { concludePlanning, dispatchPlanning } from '../../src/planning.js'
import { OUTPUT_CAP, splitRunOutput } from '../../src/runOutput.js'
import { activePumpRunIds, drainPumps, tick, type TickDeps } from '../../src/tick.js'

/**
 * M40 t3 fix round 1: a `recordDecision` that THROWS rather than refuses -- a schema violation, an
 * index violation, a database that went away mid-write. There is no honest way to provoke one from
 * outside (`concludeReplan` builds a valid situation from a valid catalogue every time), so the one
 * verb is wrapped, exactly as `tick.test.ts` wraps `workspaceStats`: the real implementation runs
 * for every id except the ones a test names in `throwingProposals`. The dist path is the module
 * `packages/control`'s barrel re-exports, so `replan.ts`'s own `@slave-of-ai/control` import
 * resolves to this same file.
 */
const { throwingProposals } = vi.hoisted(() => ({ throwingProposals: new Set<string>() }))
vi.mock('../../../../packages/control/dist/supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/control/dist/supervisor.js')>()
  return {
    ...actual,
    recordDecision: (...args: Parameters<typeof actual.recordDecision>) => {
      if (throwingProposals.has(args[0].situation.subjectId)) {
        throw new Error('recordDecision could not write this decision')
      }
      return actual.recordDecision(...args)
    },
  }
})

/**
 * H2: a role the staffing boundary accepts and no seat actually holds -- the seat that was open when
 * `staffedRolesForWorkspace` read it, closed by the time the rows are written. The only way to reach
 * `chooseAssignee`'s `null` arm through `concludePlanning`, since the Task 5 boundary otherwise
 * refuses such a board before a row exists; the real implementation runs for every role except the
 * ones a test names in `pretendStaffed`.
 */
const { pretendStaffed } = vi.hoisted(() => ({ pretendStaffed: new Set<string>() }))
vi.mock('../../src/staffing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/staffing.js')>()
  return {
    ...actual,
    staffedRolesForWorkspace: async (workspaceId: string): Promise<readonly string[]> => [
      ...new Set([...(await actual.staffedRolesForWorkspace(workspaceId)), ...pretendStaffed]),
    ],
  }
})

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository: the planning run's `worktreePath` is the primary checkout itself. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-planning-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly repoPath: string
}

async function seed(goal: string | null, goalSetByUserId?: string | null): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      goal,
      ...(goalSetByUserId === undefined ? {} : { goalSetByUserId }),
    },
  })
  // M12 Task 8: no slave in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here refuses instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id, repoPath }
}

/**
 * A slave staffable as a manager. Its TITLE is deliberately not "manager" (M37 t3): staffing
 * matches `runtimeRoles`, so a fixture where the two agreed would pass whichever column
 * `dispatchPlanning` happened to read.
 */
async function addManager(teamId: string, name = 'Atlas'): Promise<string> {
  const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineering Lead', runtimeRoles: ['manager'], personId: (await prisma.person.create({ data: { name: name } })).id } })
  return slave.id
}

/** A `backend` slave -- the role every task the `plan-graph` fixture describes requires. */
async function addBackendSlave(teamId: string, name = 'Beryl'): Promise<string> {
  const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: name } })).id } })
  return slave.id
}

/**
 * `deps.registry` for a test that only ever runs against one adapter instance (the ordinary case
 * pre-Task-8, when every run resolves to `'claude_code'` regardless of what `kind` is asked for).
 */
function singleAdapterRegistry(adapter: ClaudeCodeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

function depsFor(workspaceId: string, fixture = 'm8-flow', hookPath = REAL_GATE): TickDeps {
  return {
    workspaceId: brandWorkspaceId(workspaceId),
    registry: singleAdapterRegistry(
      new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', fixture], hookPath }),
    ),
  }
}

describe('dispatchPlanning', () => {
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('(a) starts a planning run when the goal is set, the board is empty and a manager is idle', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).not.toBeNull()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'planning' } })
    expect(run.kind).toBe('planning')
    expect(run.taskId).toBeNull()

    await drainPumps()
    const events = await prisma.executionEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } })
    const outputEvents = events.filter(
      (event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] === 'run.output',
    )
    expect(outputEvents.length).toBeGreaterThan(0)
    for (const event of outputEvents) expect(event.taskId).toBeNull()
  })

  it('refuses with the spec-verbatim unmeasurable_budget text when a budgeted workspace resolves a cost-blind runtime', async (): Promise<void> => {
    // Spec §6's dispatch-time re-check reaches every dispatch site, not just `tick.ts` (M12 Task 9,
    // ruling R9). A planning run spends real money and counts toward the same budget, so a
    // workspace that cannot measure it must refuse it here too.
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)
    await prisma.slave.update({ where: { id: managerId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 20 } })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'planning' } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    // `refusalText()` IMPORTED, not hand-copied: an implementation that threw `new Error('boom')`
    // fails this test, which is the whole standard Task 8's F3 established.
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'unmeasurable_budget', workspaceId: fixture.workspaceId, provider: 'cursor' }),
    )
  })

  it('(b) starts nothing when a task already exists, regardless of status', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Pre-existing task',
        description: 'already on the board',
        status: 'backlog',
        maxAttempts: 3,
      },
    })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('(c) starts nothing with no goal set', async (): Promise<void> => {
    const fixture = await seed(null)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('(d) starts nothing a second time while the planning run it started is still live', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    const deps = depsFor(fixture.workspaceId)

    // Not awaited beyond the dispatch itself -- the pump outlives this call by design, exactly as
    // `dispatchReview`'s own precedent (review.test.ts) relies on: the fake CLI's spawn and its
    // first line both take real time, so the run is still non-terminal when the second call reads
    // it a moment later.
    const first = await dispatchPlanning(deps)
    expect(first).not.toBeNull()

    const second = await dispatchPlanning(deps)

    expect(second).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(1)
  })

  it('(d2) starts nothing while a succeeded planning run is still being concluded by its pump', async (): Promise<void> => {
    // The window this closes: the pump writes `status: succeeded` on the run row, and the tasks
    // are written afterwards by `verifyConcludedRun -> concludePlanning` on the same pump chain.
    // A tick in between sees an empty board and no non-terminal planning run, and started a
    // second planner (observed 2026-09-20: two graphs for one goal, the second one discarded).
    // The pump registry outlives the row's status -- `activePumpRunIds` holds the id until the
    // chain's `finally` -- so the registry is what says "still concluding".
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)
    const deps = depsFor(fixture.workspaceId)

    const now = new Date()
    const concluding = await prisma.slaveRun.create({
      data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    activePumpRunIds.add(concluding.id)
    try {
      expect(await dispatchPlanning(deps)).toBeNull()
      expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(1)
    } finally {
      activePumpRunIds.delete(concluding.id)
    }

    // Once the chain has let go of the id, the same empty board is planned exactly as before.
    expect(await dispatchPlanning(deps)).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(2)
  })

  it('(e) escalates once with no manager-role slave in the workspace, and starts nothing', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    // No manager-role slave exists.

    const first = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(first).toBeNull()

    const second = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(second).toBeNull()

    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noPlannerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_planner',
    )
    expect(noPlannerEvents).toHaveLength(1)
    expect(noPlannerEvents[0]?.taskId).toBeNull()
  })

  // M37 t3: the counterpart of `addManager` above. A slave whose title is literally "manager" but
  // whose runtime role set is empty has been taken out of rotation by an operator and must not be
  // staffed -- the escalation fires exactly as it does for a workspace with no manager at all.
  it('never staffs a slave titled manager whose runtime role set is empty', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await prisma.slave.create({ data: { teamId: fixture.teamId, role: 'manager', runtimeRoles: [], personId: (await prisma.person.create({ data: { name: 'Parked' } })).id } })

    expect(await dispatchPlanning(depsFor(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    expect(
      guardrails.filter((event) => (event.payload as { guardrail?: string }).guardrail === 'no_planner'),
    ).toHaveLength(1)
  }, 60_000)

  it('(f) starts nothing once two planning runs newer than the goal have failed', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)

    const now = new Date()
    await prisma.slaveRun.create({
      data: {
        slaveId: managerId,
        kind: 'planning',
        status: 'failed',
        startedAt: now,
        terminalAt: now,
        endedAt: now,
      },
    })
    await prisma.slaveRun.create({
      data: {
        slaveId: managerId,
        kind: 'planning',
        status: 'failed',
        startedAt: now,
        terminalAt: now,
        endedAt: now,
      },
    })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(2)
  })

  it('grants fresh attempts when the goal is re-set after two failures', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)

    // Two failures from the PREVIOUS goal, stamped before the goal_set event below: the retry
    // cap counts only failures newer than the latest goal_set, so re-setting the goal is what
    // buys the workspace a fresh plan instead of silence forever.
    const past = new Date(Date.now() - 60_000)
    for (let i = 0; i < 2; i += 1) {
      await prisma.slaveRun.create({
        data: { slaveId: managerId, kind: 'planning', status: 'failed', startedAt: past, terminalAt: past, endedAt: past },
      })
    }
    await prisma.executionEvent.create({
      data: {
        type: 'workspace_goal_set',
        workspaceId: fixture.workspaceId,
        actor: 'human',
        payload: { goal: 'Ship the checkout redesign' },
      },
    })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(3)
  })

  it('(h) records a real run.failed with no taskId when the spawn itself fails', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // A relative hookPath makes `ClaudeCodeAdapter.start`'s pre-flight gate throw before a
    // process is ever spawned -- the spawn-failure branch, exercised for real rather than by
    // hand-inserting a row.
    const deps = depsFor(fixture.workspaceId, 'm8-flow', 'relative/pause-gate.sh')

    const runId = await dispatchPlanning(deps)

    expect(runId).toBeNull()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'planning' } })
    expect(run.status).toBe('failed')
    expect(run.taskId).toBeNull()

    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.taskId).toBeNull()
  })
})

describe('concludePlanning', () => {
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  it('(a) turns a valid task graph into the board, in one pass', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // Task 5: the plan-graph fixture writes every task with `role: 'backend'`.
    await addBackendSlave(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId as string } })
    expect(run.status).toBe('succeeded')

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(3)
    for (const task of tasks) {
      expect(task.requiredRole).toBe('backend')
      expect(task.createdBy).toBe('slave')
      expect(task.status).toBe('ready')
    }

    const core = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Write the feature core' },
    })
    const api = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Expose the API' },
    })
    const polish = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document and polish' },
    })

    const deps = await prisma.taskDependency.findMany({
      where: { taskId: { in: [core.id, api.id, polish.id] } },
    })
    expect(deps).toHaveLength(2)
    expect(deps).toEqual(
      expect.arrayContaining([
        { taskId: api.id, dependsOnTaskId: core.id },
        { taskId: polish.id, dependsOnTaskId: api.id },
      ]),
    )

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId },
      orderBy: { seq: 'asc' },
    })
    const taskCreated = events.filter((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] === 'task.created')
    expect(taskCreated).toHaveLength(3)

    const planCreated = events.filter(
      (event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] === 'workspace.plan_created',
    )
    expect(planCreated).toHaveLength(1)
    // M23 E1: the plan names its planner -- the communication graph's `plan` edge is derived
    // from this field, not from `runId` (which the fold never reads).
    expect(planCreated[0]?.slaveId).toBe(run.slaveId)
    const payload = planCreated[0]?.payload as unknown as { goal: string; tasks: readonly { title: string }[] }
    expect(payload.goal).toBe('Ship the checkout redesign')
    expect(payload.tasks.map((task) => task.title).sort()).toEqual(
      ['Document and polish', 'Expose the API', 'Write the feature core'].sort(),
    )
  })

  it('carries the workspace goalSetByUserId onto every task it creates (M23 F6)', async (): Promise<void> => {
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant-for-this-test' } })
    const fixture = await seed('Ship the checkout redesign', user.id)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await addBackendSlave(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) expect(task.createdByUserId).toBe(user.id)
  })

  it('gives every task it creates the seat that holds its role, and says so on task.created (H2)', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    const beryl = await addBackendSlave(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(3)
    // Every one of these was null before H2, and the board said "unassigned" about work that was
    // always somebody's: the plan fixture writes `role: 'backend'`, and Beryl is who holds it.
    for (const task of tasks) expect(task.assigneeId).toBe(beryl)

    const created = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'task_created' },
    })
    expect(created).toHaveLength(3)
    for (const event of created) expect(event.payload).toMatchObject({ assigneeId: beryl })
  })

  it('creates the task with nobody on it when no seat holds its role by the time the board is written (H2)', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // No `backend` seat at all -- staffing is made to claim one, which is the shape of the race
    // where the seat closes between the boundary's read and the write. Nobody is invented for it.
    pretendStaffed.add('backend')
    try {
      const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
      expect(runId).not.toBeNull()
      await drainPumps()

      const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(tasks).toHaveLength(3)
      for (const task of tasks) expect(task.assigneeId).toBeNull()

      const created = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspaceId, type: 'task_created' },
      })
      expect(created).toHaveLength(3)
      for (const event of created) expect(event.payload).toMatchObject({ assigneeId: null })
    } finally {
      pretendStaffed.clear()
    }
  })

  it('leaves the task with the busy holder of its role rather than with nobody (H2)', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    const beryl = await addBackendSlave(fixture.teamId)
    // Mid-run on something else. A role held only by somebody busy is still a role this project
    // serves, so the task is theirs and waits for them.
    await prisma.slaveRun.create({ data: { slaveId: beryl, kind: 'implementation', status: 'working' } })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(3)
    for (const task of tasks) expect(task.assigneeId).toBe(beryl)
  })

  it('passes over a CLOSED seat and a RELEASED person when it names the holder (H2)', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // Explicit ids, lowest first: if a closed seat or a released person were still a candidate, the
    // tie-break would hand every task to one of them, so this cannot pass by luck.
    const closed = await prisma.slave.create({
      data: {
        id: '00000000-0000-4000-8000-000000000001',
        teamId: fixture.teamId,
        role: 'backend',
        runtimeRoles: ['backend'],
        closedAt: new Date(),
        personId: (await prisma.person.create({ data: { name: 'Gone Seat' } })).id,
      },
    })
    const released = await prisma.slave.create({
      data: {
        id: '00000000-0000-4000-8000-000000000002',
        teamId: fixture.teamId,
        role: 'backend',
        runtimeRoles: ['backend'],
        personId: (
          await prisma.person.create({ data: { name: 'Gone Person', releasedAt: new Date(), releaseReason: 'done' } })
        ).id,
      },
    })
    const open = await prisma.slave.create({
      data: {
        id: 'ffffffff-0000-4000-8000-000000000003',
        teamId: fixture.teamId,
        role: 'backend',
        runtimeRoles: ['backend'],
        personId: (await prisma.person.create({ data: { name: 'Beryl' } })).id,
      },
    })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(3)
    for (const task of tasks) {
      expect(task.assigneeId).toBe(open.id)
      expect(task.assigneeId).not.toBe(closed.id)
      expect(task.assigneeId).not.toBe(released.id)
    }
  })

  it('(b) a subsequent dispatchPlanning starts nothing once the graph became the board', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await addBackendSlave(fixture.teamId)

    const first = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(first).not.toBeNull()
    await drainPumps()
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)

    const second = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(second).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(1)
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)
  })

  it('(c) fails the run and creates no tasks when the planning output carries no valid graph', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId, 'review-invalid'))
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId as string } })
    expect(run.status).toBe('failed')

    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain(
      'planning run produced no valid task graph',
    )

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
  })

  it('builds the board from a plan LONGER than one output row, which every real plan is', async (): Promise<void> => {
    // The failure this pins: a plan graph is one message of many thousand characters, `run.output`
    // rows are capped, and the cap used to drop the remainder -- so `parsePlanGraph` was handed
    // half an object and refused it with "no JSON object with { "tasks": [...] } found" while the
    // model had produced a perfectly good graph. Three real planning runs on one project failed
    // that way in a row. The rows here are written exactly as the pump now writes them.
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)
    await addBackendSlave(fixture.teamId)

    const now = new Date()
    const run = await prisma.slaveRun.create({
      data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    // Long enough to span rows, and long because of a DESCRIPTION -- the field a real planner
    // fills with a brief -- so the boundary lands inside a JSON string literal, where a newline
    // welded between two rows would be an illegal control character.
    const graph = JSON.stringify({
      tasks: [
        {
          key: 'core',
          title: 'Write the feature core',
          description: `Implement the core module. ${'Context that a real planner writes at length. '.repeat(120)}`,
          role: 'backend',
          dependsOn: [],
        },
      ],
    })
    expect(graph.length).toBeGreaterThan(OUTPUT_CAP)
    let seq = 0
    for (const payload of splitRunOutput(graph)) {
      seq += 1
      await prisma.executionEvent.create({
        data: {
          type: 'run_output',
          workspaceId: fixture.workspaceId,
          slaveId: managerId,
          runId: run.id,
          actor: 'slave',
          payload: { ...payload },
        },
      })
    }
    expect(seq).toBeGreaterThan(1)

    await concludePlanning(brandRunId(run.id))

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('Write the feature core')
    // And the whole brief survived, not just the part that fitted the first row.
    expect(tasks[0]?.description).toContain('Context that a real planner writes at length.')
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_failed' } })).toBe(0)
  })

  it('(d) warns and creates no NEW tasks when the board grew a task before conclusion', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)

    const now = new Date()
    const run = await prisma.slaveRun.create({
      data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    await prisma.executionEvent.create({
      data: {
        type: 'run_output',
        workspaceId: fixture.workspaceId,
        slaveId: managerId,
        runId: run.id,
        actor: 'slave',
        payload: {
          text: '{"tasks":[{"key":"core","title":"Write the feature core","description":"Implement the core module.","role":"backend","dependsOn":[]}]}',
        },
      },
    })

    // An operator (or here, the test) races the plan: a task lands on the board between the
    // run's success and its conclusion.
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Operator-seeded task',
        description: 'already on the board',
        status: 'backlog',
        maxAttempts: 3,
      },
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {})
    try {
      await concludePlanning(brandRunId(run.id))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe(seeded.id)

    const planCreated = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
    })
    expect(planCreated).toHaveLength(0)
  })

  /**
   * M47 R3: a graph written in the taxonomy's vocabulary, concluded in process.
   *
   * Hand-seeded rather than driven through the fake CLI on purpose: the fake's planning fixture is
   * a fixed file with no capabilities in it, and the flag that would let a test choose another one
   * arrives in Task 5. What is under test is `concludePlanning`, and this is the same shape case
   * (d) above already uses to feed it a graph.
   */
  /**
   * A succeeded planning run with its output, and -- when the case names one -- the `runbook`
   * section its recorded manifest would carry.
   *
   * The manifest is what `concludePlanning` reads the stage vocabulary off since M48's final review
   * (Important 3): a run that was SHOWN a runbook is the only run whose graph may be judged against
   * one. `shownRunbook` is therefore the same key the case adopts, spelt separately because the two
   * are separately true -- the point of the ruling is that they can differ.
   */
  async function concludeGraph(
    fixture: Fixture,
    graph: unknown,
    // Task 5: every task this file hands to `concludeGraph` names `role: 'backend'` unless it
    // says otherwise, or derives one from a capability -- `security.application` derives
    // `security`. `roles` stages exactly the seats conclusion-time validation now demands, so a
    // case testing something else entirely does not have to know that staffing exists at all.
    // `[]` opts a case OUT, for the handful that are testing the refusal itself.
    options: { readonly shownRunbook?: string; readonly roles?: readonly string[] } = {},
  ): Promise<string> {
    const managerId = await addManager(fixture.teamId)
    for (const role of options.roles ?? ['backend']) {
      await prisma.slave.create({
        data: {
          teamId: fixture.teamId,
          role,
          runtimeRoles: [role],
          personId: (await prisma.person.create({ data: { name: `Staffed-${role}-${randomUUID()}` } })).id,
        },
      })
    }
    const now = new Date()
    const run = await prisma.slaveRun.create({
      data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    if (options.shownRunbook !== undefined) {
      const shown = await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: options.shownRunbook } })
      const stages = shown.stages as { key: string }[]
      await prisma.runContext.create({
        data: {
          runId: run.id,
          prompt: 'the planning prompt this run was sent',
          sections: {
            kind: 'planning',
            sections: [
              { kind: 'runbook', runbookId: shown.id, key: shown.key, stageKeys: stages.map((stage) => stage.key) },
            ],
          },
        },
      })
    }
    await prisma.executionEvent.create({
      data: {
        type: 'run_output',
        workspaceId: fixture.workspaceId,
        slaveId: managerId,
        runId: run.id,
        actor: 'slave',
        payload: { text: JSON.stringify(graph) },
      },
    })
    await concludePlanning(brandRunId(run.id))
    return run.id
  }

  it('stores the required capabilities and derives the role from them (M47 R3)', async (): Promise<void> => {
    // The taxonomy is a TABLE, and this run's derivation reads it: reconciled first so the case
    // does not depend on when the test database was last seeded.
    await syncCapabilityTaxonomy()
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await concludeGraph(
      fixture,
      {
        tasks: [
          {
            key: 'a',
            title: 'Harden the login',
            description: 'Review the authentication path.',
            capabilities: ['security.application'],
            dependsOn: [],
          },
        ],
      },
      { roles: ['security'] },
    )

    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(task.requiredCapabilities).toEqual(['security.application'])
    expect(task.requiredRole).toBe('security')
    // ...and the event says what was STORED, not what the planner asked for.
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
    })
    expect((event.payload as { tasks: { role: string }[] }).tasks[0]?.role).toBe('security')
  })

  it("keeps the planner's own role when it named one, capabilities or not", async (): Promise<void> => {
    await syncCapabilityTaxonomy()
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await concludeGraph(fixture, {
      tasks: [
        {
          key: 'a',
          title: 'Harden the login',
          description: 'Review the authentication path.',
          role: 'backend',
          capabilities: ['security.application'],
          dependsOn: [],
        },
      ],
    })

    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(task.requiredRole).toBe('backend')
    expect(task.requiredCapabilities).toEqual(['security.application'])
  })

  it('drops a key the taxonomy does not have and records it on the plan event', async (): Promise<void> => {
    await syncCapabilityTaxonomy()
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await concludeGraph(fixture, {
      tasks: [
        {
          key: 'a',
          title: 'Harden the login',
          description: 'Review the authentication path.',
          role: 'backend',
          capabilities: ['nope.nothing'],
          dependsOn: [],
        },
      ],
    })

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
    })
    expect((event.payload as { droppedCapabilities?: string[] }).droppedCapabilities).toEqual(['nope.nothing'])
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(task.requiredCapabilities).toEqual([])
  })

  // Fix round 1, Important: a task whose every capability the taxonomy dropped derives NO role, and
  // a null `requiredRole` is a task both world loaders exclude and `task.count` still sees -- the
  // board is never empty again, so planning refuses forever. Refused BEFORE the transaction, so the
  // board stays empty and the retry cap governs.
  it('fails the run and writes no board when a task asks only for capabilities the taxonomy lacks', async (): Promise<void> => {
    await syncCapabilityTaxonomy()
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const runId = await concludeGraph(fixture, {
      tasks: [
        {
          key: 'a',
          title: 'Harden the login',
          description: 'Review the authentication path.',
          capabilities: ['nope.nothing'],
          dependsOn: [],
        },
      ],
    })

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      'planning run produced no valid task graph: task "a" asks only for capabilities the taxonomy does not have',
    )
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' } }),
    ).toBe(0)
  })

  it('keeps a task that named one unknown key beside a known one, with the known key\'s role', async (): Promise<void> => {
    await syncCapabilityTaxonomy()
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await concludeGraph(
      fixture,
      {
        tasks: [
          {
            key: 'a',
            title: 'Harden the login',
            description: 'Review the authentication path.',
            capabilities: ['nope.nothing', 'security.application'],
            dependsOn: [],
          },
        ],
      },
      { roles: ['security'] },
    )

    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(task.requiredCapabilities).toEqual(['security.application'])
    expect(task.requiredRole).toBe('security')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
    })
    expect((event.payload as { droppedCapabilities?: string[] }).droppedCapabilities).toEqual(['nope.nothing'])
  })

  // E R5: the permission a task needs is a fact the PLANNER knows and nobody was asking it for.
  // The needs it writes land on the row `startRun` reads at dispatch, so a research task that must
  // read the web arrives with the grant rather than failing three times for the want of it.
  describe('the needs a task carries (E R5)', () => {
    it('writes the needs onto the row, and nothing about them onto the plan event', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await concludeGraph(fixture, {
        tasks: [
          {
            key: 'a',
            title: 'Research the competitors',
            description: 'Read what the market does.',
            role: 'backend',
            needs: ['network_fetch'],
            dependsOn: [],
          },
          { key: 'b', title: 'Write it up', description: 'A memo.', role: 'backend', dependsOn: ['a'] },
        ],
      })

      const research = await prisma.task.findFirstOrThrow({ where: { title: 'Research the competitors' } })
      expect(research.requiredPermissions).toEqual(['network_fetch'])
      // A task that asked for nothing needs nothing -- the column's default, written explicitly.
      const memo = await prisma.task.findFirstOrThrow({ where: { title: 'Write it up' } })
      expect(memo.requiredPermissions).toEqual([])
      const event = await prisma.executionEvent.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
      })
      expect((event.payload as { droppedNeeds?: unknown }).droppedNeeds).toBeUndefined()
    })

    it('drops a need the list does not have, records it on the plan event, and still builds the board', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await concludeGraph(fixture, {
        tasks: [
          {
            key: 'a',
            title: 'Research the competitors',
            description: 'Read what the market does.',
            role: 'backend',
            needs: ['network_fetch', 'sudo'],
            dependsOn: [],
          },
        ],
      })

      const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      expect(task.requiredPermissions).toEqual(['network_fetch'])
      const event = await prisma.executionEvent.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
      })
      expect((event.payload as { droppedNeeds?: Record<string, string[]> }).droppedNeeds).toEqual({ a: ['sudo'] })
    })
  })

  // Task 5: a board may never be created with a role nobody on the project can serve. Prompt
  // guidance (`runContext.ts`'s `rolesSection`) is not enforcement -- a model can still ignore it
  // and write a role no seat carries -- so conclusion re-checks LIVE staffing before a single Task
  // row is written.
  describe('Task 5: a role no staffed seat carries', () => {
    it('fails the run and leaves the board empty when one task names an unstaffed role', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      // `roles: []`: only the manager is staffed -- deliberately no `backend` seat, so the task
      // below names a role nobody on this project can serve.
      const runId = await concludeGraph(
        fixture,
        { tasks: [{ key: 'a', title: 'Write the feature core', description: 'd', role: 'backend', dependsOn: [] }] },
        { roles: [] },
      )

      expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
      expect(await prisma.taskDependency.count()).toBe(0)
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
      expect(run.status).toBe('failed')
      expect(
        await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' } }),
      ).toBe(0)
    })

    it('names the first offending task and its role in the failure reason', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      const runId = await concludeGraph(
        fixture,
        {
          tasks: [
            { key: 'core', title: 'Write the feature core', description: 'd', role: 'backend', dependsOn: [] },
            { key: 'palette', title: 'Pick a palette', description: 'd', role: 'design', dependsOn: [] },
          ],
        },
        // `backend` staffed, `design` is not: the SECOND task is the first offending one, and the
        // reason has to name IT, not the one that would have been fine.
        { roles: ['backend'] },
      )

      const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
      expect(failures).toHaveLength(1)
      const reason = (failures[0]?.payload as { reason: string }).reason
      // The SECOND task's own key, title and role -- not the first one, which was fine.
      expect(reason).toContain('"palette"')
      expect(reason).toContain('Pick a palette')
      expect(reason).toContain('role "design"')
      expect(reason).not.toContain('"core"')
    })

    it('passes when the role is carried only by a BUSY seat, which is staffed and merely occupied', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      const managerId = await addManager(fixture.teamId)
      const busy = await prisma.slave.create({
        data: {
          teamId: fixture.teamId,
          role: 'backend',
          runtimeRoles: ['backend'],
          personId: (await prisma.person.create({ data: { name: `Busy ${randomUUID()}` } })).id,
        },
      })
      // Non-terminal: this seat is mid-run, not idle -- `staffedRolesForWorkspace` does not filter
      // on busyness, only on `closedAt`/`releasedAt`, the same distinction `world.ts`'s own
      // `unservedRoles` makes for the tick report.
      await prisma.slaveRun.create({ data: { slaveId: busy.id, kind: 'implementation', status: 'working' } })

      const now = new Date()
      const run = await prisma.slaveRun.create({
        data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
      })
      await prisma.executionEvent.create({
        data: {
          type: 'run_output',
          workspaceId: fixture.workspaceId,
          slaveId: managerId,
          runId: run.id,
          actor: 'slave',
          payload: {
            text: JSON.stringify({
              tasks: [{ key: 'a', title: 'Write the feature core', description: 'd', role: 'backend', dependsOn: [] }],
            }),
          },
        },
      })

      await concludePlanning(brandRunId(run.id))

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
      expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    })

    it('fails when the only seat holding the role is CLOSED or its Person RELEASED', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      const closedPerson = await prisma.person.create({ data: { name: `Closed ${randomUUID()}` } })
      await prisma.slave.create({
        data: { teamId: fixture.teamId, role: 'backend', runtimeRoles: ['backend'], personId: closedPerson.id, closedAt: new Date() },
      })
      const releasedPerson = await prisma.person.create({ data: { name: `Released ${randomUUID()}`, releasedAt: new Date() } })
      await prisma.slave.create({
        data: { teamId: fixture.teamId, role: 'design', runtimeRoles: ['design'], personId: releasedPerson.id },
      })

      const runId = await concludeGraph(
        fixture,
        { tasks: [{ key: 'a', title: 'Write the feature core', description: 'd', role: 'backend', dependsOn: [] }] },
        { roles: [] },
      )

      expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
      const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
      expect(failures).toHaveLength(1)
      expect((failures[0]?.payload as { reason: string }).reason).toContain('"backend"')
    })

    // M40 erratum-style live reading (spec: "conclusion-time live staffing wins"): the prompt this
    // run was actually sent named no roles at all -- the manifest is silent -- and by the time it
    // concludes a seat has been hired that serves the role it wrote. Conclusion must not judge the
    // graph by what the PROMPT said; only the database at conclusion time counts.
    it('honors staffing as it stands at CONCLUSION, not as it stood when the prompt was built', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      const managerId = await addManager(fixture.teamId)

      const now = new Date()
      const run = await prisma.slaveRun.create({
        data: { slaveId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
      })
      await prisma.executionEvent.create({
        data: {
          type: 'run_output',
          workspaceId: fixture.workspaceId,
          slaveId: managerId,
          runId: run.id,
          actor: 'slave',
          payload: {
            text: JSON.stringify({
              tasks: [{ key: 'a', title: 'Write the feature core', description: 'd', role: 'backend', dependsOn: [] }],
            }),
          },
        },
      })

      // Nobody carried `backend` when this run was dispatched -- the hire below happens AFTER the
      // run's own output was written, simulating a hire that landed while the run was thinking.
      await addBackendSlave(fixture.teamId)

      await concludePlanning(brandRunId(run.id))

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
      const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      expect(task.requiredRole).toBe('backend')
    })
  })

  it('(e) the daemon-shape follow-through: a further tick starts an implementation run for the root task', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await addBackendSlave(fixture.teamId)
    const deps = depsFor(fixture.workspaceId)

    const runId = await dispatchPlanning(deps)
    expect(runId).not.toBeNull()
    await drainPumps()
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)

    const report = await tick(deps)

    expect(report.started).toHaveLength(1)
    const core = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Write the feature core' },
    })
    expect(core.status).toBe('running')
    expect(core.activeRunId).not.toBeNull()
  })

  /**
   * M48 R2: the adopted runbook decides which stages a plan may name, what a stage's tasks may
   * retry, and what the plan's adherence is measured against. Fed in process, exactly as the
   * capability cases above are: the fake CLI's runbook-aware planning fixture lands in Task 5.
   */
  describe('the contract and the stage on the board (M48 R2)', () => {
    async function adopt(workspaceId: string, key: string | null): Promise<void> {
      await syncRunbooks()
      const result = await adoptRunbook(workspaceId, key)
      expect(result.ok).toBe(true)
    }

    it('writes the handoff, the stage and the stage retry, and reports adherence on the event', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await adopt(fixture.workspaceId, 'feature-delivery')

      await concludeGraph(fixture, {
        tasks: [
          {
            key: 'design',
            title: 'Decide the shape',
            description: 'd',
            role: 'backend',
            stage: 'design',
            handoff: {
              objective: 'Decide the interface',
              expectedOutput: 'An interface the rest is written against',
              acceptanceCriteria: ['It names every route'],
            },
          },
          { key: 'build', title: 'Build it', description: 'd', role: 'backend', stage: 'verify', dependsOn: ['design'] },
        ],
      }, { shownRunbook: 'feature-delivery' })

      const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId }, orderBy: { createdAt: 'asc' } })
      expect(tasks[0]?.stage).toBe('design')
      expect(tasks[0]?.handoff).toMatchObject({ objective: 'Decide the interface', acceptanceCriteria: ['It names every route'] })
      expect(tasks[0]?.maxAttempts).toBe(3) // the workspace's own: the design stage sets no retry
      expect(tasks[1]?.stage).toBe('verify')
      expect(tasks[1]?.maxAttempts).toBe(2) // the verify stage's retry.maxAttempts
      expect(tasks[1]?.handoff).toBeNull()

      const event = await prisma.executionEvent.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
      })
      expect(event.payload).toMatchObject({
        runbook: { key: 'feature-delivery', stagesCovered: ['design', 'verify'], stagesMissing: ['implement', 'review', 'release'] },
      })
    })

    it('refuses a stage the adopted runbook does not have, and leaves the board empty (E1)', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await adopt(fixture.workspaceId, 'feature-delivery')

      const runId = await concludeGraph(
        fixture,
        { tasks: [{ key: 'k', title: 'T', description: 'd', role: 'backend', stage: 'polish' }] },
        { shownRunbook: 'feature-delivery' },
      )

      expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
      const failure = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'run_failed' } })
      expect((failure.payload as { reason: string }).reason).toContain('names stage "polish"')
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('failed')
    })

    // Plan erratum E16: a half-contract is a planning failure, not a silent null column -- and the
    // refusal happens BEFORE a single row is written.
    it('refuses a malformed handoff and leaves the board empty', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)

      const runId = await concludeGraph(fixture, {
        tasks: [{ key: 'k', title: 'T', description: 'd', role: 'backend', handoff: { objective: 'only half' } }],
      })

      expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
      const failure = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'run_failed' } })
      expect((failure.payload as { reason: string }).reason).toContain('handoff that is not a contract')
    })

    /**
     * M48 final review, Important 3. The runbook moved WHILE the run was in flight.
     *
     * The planner was shown Feature delivery and wrote its stages down; by the time its graph came
     * back the project had adopted Bug fix. Reading the vocabulary at conclude time refused the
     * whole model-authored graph -- "names stage \"design\", which this runbook does not have" --
     * and burnt a planning attempt over a column somebody moved. The run's own manifest is the
     * record of what was asked for, so the graph lands; the MEASUREMENT is against what the project
     * follows now, and it says plainly that none of those stages is one of its own.
     */
    it('judges the graph by the runbook the RUN was shown, and measures it against the one adopted now', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await adopt(fixture.workspaceId, 'feature-delivery')

      // ...the prompt went out against `feature-delivery` (the manifest below), and only then does
      // somebody choose a different way of working.
      await adopt(fixture.workspaceId, 'bug-fix')

      const runId = await concludeGraph(
        fixture,
        {
          tasks: [
            { key: 'a', title: 'Decide the shape', description: 'd', role: 'backend', stage: 'design' },
            { key: 'b', title: 'Prove it', description: 'd', role: 'backend', stage: 'verify', dependsOn: ['a'] },
          ],
        },
        { shownRunbook: 'feature-delivery' },
      )

      // The run SUCCEEDED and the board carries the stages the planner was actually asked for.
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded')
      const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId }, orderBy: { createdAt: 'asc' } })
      expect(tasks.map((task) => task.stage)).toEqual(['design', 'verify'])
      // The retry cap comes from the runbook the run was shown, too: `verify` sets one, and the
      // runbook adopted now has a `verify` of its own with the same cap -- so this asserts the
      // stage was found at all rather than silently falling back to the workspace's 3.
      expect(tasks[1]?.maxAttempts).toBe(2)

      // And the measurement is honest: against `bug-fix`, `design` is a stage it does not have and
      // every one of its own stages is missing.
      const event = await prisma.executionEvent.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
      })
      expect(event.payload).toMatchObject({
        runbook: { key: 'bug-fix', stagesCovered: ['verify'], stagesMissing: ['reproduce', 'fix', 'review'] },
      })
      const status = await runbookStatus(fixture.workspaceId)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.value.unknownStages).toEqual(['design'])
      expect(status.value.stagesMissing).toEqual(['reproduce', 'fix', 'review'])
    })

    // E1's empty list, reached the way it is actually reached: a run whose manifest records no
    // runbook section at all -- a project that had adopted none when the prompt went out, or a run
    // from before this milestone. Whatever stage the planner wrote is stored and measured later.
    it('imposes no stage vocabulary on a run that was shown no runbook, even with one adopted now', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await adopt(fixture.workspaceId, 'feature-delivery')

      await concludeGraph(fixture, {
        tasks: [{ key: 'k', title: 'T', description: 'd', role: 'backend', stage: 'a-stage-nobody-has' }],
      })

      const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      expect(task.stage).toBe('a-stage-nobody-has')
      expect(task.maxAttempts).toBe(3)
      const status = await runbookStatus(fixture.workspaceId)
      expect(status.ok && status.value.unknownStages).toEqual(['a-stage-nobody-has'])
    })

    it('carries no runbook block on the event when no runbook is adopted', async (): Promise<void> => {
      const fixture = await seed('Ship the checkout redesign')
      repos.push(fixture.repoPath)
      await adopt(fixture.workspaceId, null)

      await concludeGraph(fixture, {
        tasks: [{ key: 'k', title: 'T', description: 'd', role: 'backend', stage: 'anything-at-all' }],
      })

      const event = await prisma.executionEvent.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' },
      })
      expect(event.payload).not.toHaveProperty('runbook')
      // The stage is still STORED: an empty stage list is "no runbook adopted", under which any
      // stage stands (E1), and a label nobody can measure is still what the planner said.
      const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      expect(task.stage).toBe('anything-at-all')
    })
  })
})

/**
 * M40 §5: the goal changed under a board that already exists.
 *
 * Every test here drives the REAL trigger (`dispatchPlanning`) and, where it concludes, the real
 * `concludePlanning` routing (spec erratum E4: the run's own recorded manifest is what says a run
 * was a re-plan, not its kind).
 */
describe('a re-plan', () => {
  const repos: string[] = []
  const V1 = 'Ship the checkout redesign'
  const V2 = 'Ship the checkout redesign and document the new endpoint'

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  /** `deps` for a re-plan dispatch: the fake CLI's re-plan arm needs the id to cancel in ARGV,
   *  because no fixture can know a row the test just created (spec erratum E3/E6). */
  function depsForReplan(workspaceId: string, cancelTaskId?: string): TickDeps {
    return {
      workspaceId: brandWorkspaceId(workspaceId),
      registry: singleAdapterRegistry(
        new ClaudeCodeAdapter({
          command: 'node',
          extraArgs: [
            FAKE,
            '--fixture',
            'm8-flow',
            ...(cancelTaskId === undefined ? [] : ['--replan-cancel', cancelTaskId]),
          ],
          hookPath: REAL_GATE,
        }),
      ),
    }
  }

  /** A board built by a REAL first plan against goal v1, so the tasks under a re-plan are the
   *  tasks a plan actually produces -- stamps, dependencies and all. */
  async function firstPlan(): Promise<{ fixture: Fixture; tasks: { id: string; title: string }[] }> {
    const fixture = await seed(null)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // Task 5: the real plan-graph fixture below writes every task with `role: 'backend'`, and
    // conclusion now refuses a board naming a role nobody can serve.
    await addBackendSlave(fixture.teamId)
    const set = await setGoal(fixture.workspaceId, V1)
    expect(set.ok).toBe(true)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId }, orderBy: { createdAt: 'asc' } })
    expect(tasks).toHaveLength(3)
    // The first-plan path is unchanged, and it stamps the version it planned from (M40 §1).
    for (const task of tasks) expect(task.goalVersion).toBe(1)
    return { fixture, tasks: tasks.map((task) => ({ id: task.id, title: task.title })) }
  }

  /** A board with no run behind it: the cheap fixture for the trigger's own arithmetic. */
  async function boardAt(version: number | null): Promise<Fixture> {
    const fixture = await seed(null)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    // Task 5: every re-plan delta below adds a `role: 'backend'` task, and conclusion now refuses
    // a board naming a role nobody can serve -- staffed here so the tests exercising everything
    // ELSE about a re-plan do not each have to know that staffing exists.
    await addBackendSlave(fixture.teamId)
    expect((await setGoal(fixture.workspaceId, V1)).ok).toBe(true)
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Expose the API',
        description: 'wire it up',
        status: 'backlog',
        // A required role is what puts a task in the SUPERVISOR's world (`loadSupervisorWorld`
        // drops a task with none), and a task the world does not carry has no `cancel_task`
        // candidate to propose -- so a board without one could never exercise a proposal at all.
        requiredRole: 'backend',
        maxAttempts: 3,
        goalVersion: version,
      },
    })
    return fixture
  }

  const replanSectionOf = async (runId: string): Promise<Record<string, unknown> | undefined> => {
    const row = await prisma.runContext.findUniqueOrThrow({ where: { runId } })
    const sections = (row.sections as unknown as { sections: Record<string, unknown>[] }).sections
    return sections.find((section) => section.kind === 'replan')
  }

  it('adds what the new goal needs, proposes what it no longer needs, and touches neither itself', async (): Promise<void> => {
    const { fixture, tasks } = await firstPlan()
    const doomed = tasks.find((task) => task.title === 'Document and polish') as { id: string; title: string }
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)

    const runId = await dispatchPlanning(depsForReplan(fixture.workspaceId, doomed.id))

    expect(runId).not.toBeNull()
    // The prompt the manager got is a re-plan prompt, and the row says so (erratum E2/E4).
    const context = await prisma.runContext.findUniqueOrThrow({ where: { runId: runId as string } })
    expect(context.prompt).toContain('"replan"')
    expect(context.prompt).not.toContain('"task graph"')
    expect(context.prompt).toContain(`- ${doomed.id} [ready] Document and polish (goal v1)`)
    expect(await replanSectionOf(runId as string)).toMatchObject({ previousVersion: 1, version: 2 })

    // The start is on the record before anything concludes -- it is what the dedup reads.
    const started = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replan_started' },
    })
    expect(started).toHaveLength(1)
    expect(started[0]?.payload).toMatchObject({ version: 2, runId: runId as string })

    await drainPumps()

    // The addition landed at once (M40 §1), stamped with the version that asked for it.
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    expect(added.goalVersion).toBe(2)
    expect(added.createdBy).toBe('slave')
    expect(added.requiredRole).toBe('backend')
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(4)

    // The cancellation is a PROPOSAL and nothing else (ruling R1): the task is exactly where it was.
    const target = await prisma.task.findUniqueOrThrow({ where: { id: doomed.id } })
    expect(target.status).toBe('ready')

    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(decisions).toHaveLength(1)
    const decision = decisions[0]
    expect(decision?.situationKind).toBe('stale_task')
    expect(decision?.subjectId).toBe(doomed.id)
    expect(decision?.status).toBe('pending')
    expect(decision?.tier).toBe('proposed')
    expect(decision?.action).toMatchObject({ kind: 'cancel_task', taskId: doomed.id })
    // The manager's own run proposed it, and no model call was made to decide that (M40 §5).
    expect(decision?.decidedBy).toBe('model')
    expect(decision?.modelCalled).toBe(false)
    expect(decision?.modelCostUsd).toBeNull()
    expect((decision?.situation as unknown as { facts: Record<string, unknown> }).facts).toMatchObject({
      goalVersion: 1,
      currentVersion: 2,
      reason: 'replan_cancel',
    })

    const created = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'task_created', taskId: added.id },
    })
    expect(created).toHaveLength(1)
    expect(created[0]?.payload).toMatchObject({ title: 'Document the new endpoint', goalVersion: 2 })

    const replanned = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned).toHaveLength(1)
    expect(replanned[0]?.payload).toEqual({
      version: 2,
      runId: runId as string,
      added: [added.id],
      proposedCancellations: [doomed.id],
      droppedCancellations: [],
      failedProposals: [],
    })
  }, 60_000)

  it('drops a cancellation the status rule refuses, records it, and proposes nothing', async (): Promise<void> => {
    const { fixture, tasks } = await firstPlan()
    const doomed = tasks.find((task) => task.title === 'Document and polish') as { id: string }
    // Work in flight is never cancellable by a re-plan (M40 §1): a wrong deletion costs real work.
    await prisma.task.update({ where: { id: doomed.id }, data: { status: 'running' } })
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)

    const runId = await dispatchPlanning(depsForReplan(fixture.workspaceId, doomed.id))
    expect(runId).not.toBeNull()
    await drainPumps()

    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: doomed.id } })).status).toBe('running')

    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toEqual({
      version: 2,
      runId: runId as string,
      added: [added.id],
      proposedCancellations: [],
      // The refusal is REPORTED, with the status that refused it -- never silently forgotten.
      droppedCancellations: [{ taskId: doomed.id, status: 'running' }],
      failedProposals: [],
    })
  }, 60_000)

  it('starts nothing while the board is already at the workspace goal version', async (): Promise<void> => {
    const fixture = await boardAt(1)

    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('starts nothing on a board whose tasks have ALL finished, while the goal stands still', async (): Promise<void> => {
    // Spec erratum E8, the bug this test exists for: the board version used to be the max over the
    // NON-terminal tasks, so a project whose every task was done had no task to take a max over,
    // the version fell to 0, and `goalVersion 1 > 0` re-planned a requirement nobody had touched --
    // a real manager run, on a real repository, told the goal had changed when it had not.
    const fixture = await boardAt(1)
    await prisma.task.updateMany({ where: { workspaceId: fixture.workspaceId }, data: { status: 'done' } })

    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
    expect(
      await prisma.executionEvent.count({
        where: { workspaceId: fixture.workspaceId, type: 'workspace_replan_started' },
      }),
    ).toBe(0)
  })

  it('still re-plans a FINISHED board when the goal genuinely moves, over an empty live board', async (): Promise<void> => {
    // The other half of erratum E8: counting terminal tasks in the max must not cost a real goal
    // edit its re-plan. The live board it is shown is empty, which is a legitimate thing to show a
    // manager -- everything the old requirement asked for is done, and the new one may need more.
    const fixture = await boardAt(1)
    await prisma.task.updateMany({ where: { workspaceId: fixture.workspaceId }, data: { status: 'done' } })
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)

    const runId = await dispatchPlanning(depsForReplan(fixture.workspaceId))

    expect(runId).not.toBeNull()
    const context = await prisma.runContext.findUniqueOrThrow({ where: { runId: runId as string } })
    expect(context.prompt).toContain('THE GOAL CHANGED')
    expect(context.prompt).toContain('New goal (v2)')
    expect(context.prompt).toContain('(nothing unfinished is on the board)')
    // The finished task is not on the board the manager may name -- it is only in the arithmetic
    // that decided this run should happen at all.
    expect(context.prompt).not.toContain('Expose the API')
  }, 60_000)

  it('reads no event log at all on a dispatch pass whose board is already current', async (): Promise<void> => {
    // Final review, Important 2: this runs on every tick of every workspace, and the ordinary
    // answer is "nothing to do". `replanIntent` therefore computes the board version first and
    // returns, instead of paying for the whole diagnosis -- two of whose reads used to be
    // unbounded scans of the workspace's entire event log.
    const fixture = await boardAt(1)

    const original = prisma.executionEvent.findMany
    let scans = 0
    Object.defineProperty(prisma.executionEvent, 'findMany', {
      configurable: true,
      writable: true,
      value: (...args: Parameters<typeof original>): unknown => {
        scans += 1
        return (original as (...call: Parameters<typeof original>) => unknown).apply(prisma.executionEvent, args)
      },
    })
    try {
      expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    } finally {
      Object.defineProperty(prisma.executionEvent, 'findMany', { configurable: true, writable: true, value: original })
    }

    expect(scans).toBe(0)
  })

  it('starts nothing for an unstamped board under a goal that was never versioned', async (): Promise<void> => {
    // `goalVersion` 0 is a hand-seeded goal (M40 §1): nothing to compare, so nothing to re-plan.
    const fixture = await seed(V1)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Hand-made task',
        description: 'no plan produced this',
        status: 'backlog',
        maxAttempts: 3,
      },
    })

    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('starts one re-plan per goal version and no more (dedup on workspace.replan_started)', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const manager = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspaceId } } })
    const now = new Date()
    const done = await prisma.slaveRun.create({
      data: { slaveId: manager.id, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    await prisma.executionEvent.create({
      data: {
        type: 'workspace_replan_started',
        workspaceId: fixture.workspaceId,
        actor: 'system',
        payload: { version: 2, runId: done.id },
      },
    })

    // The board is still at v1 -- the re-plan cancelled and added nothing -- so the version
    // comparison would fire again. The dedup is the only thing stopping it.
    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(1)
  })

  it('re-plans again when the run that started one FAILED', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const manager = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspaceId } } })
    const now = new Date()
    const dead = await prisma.slaveRun.create({
      data: { slaveId: manager.id, kind: 'planning', status: 'failed', startedAt: now, terminalAt: now, endedAt: now },
    })
    await prisma.executionEvent.create({
      data: {
        type: 'workspace_replan_started',
        workspaceId: fixture.workspaceId,
        actor: 'system',
        payload: { version: 2, runId: dead.id },
      },
    })

    // A failed re-plan is a re-plan that did not happen; the retry cap, not the dedup, is what
    // eventually stops this.
    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(2)
  }, 60_000)

  it('stops re-planning once two runs have failed against this version', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const manager = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspaceId } } })
    const now = new Date()
    for (let i = 0; i < 2; i += 1) {
      await prisma.slaveRun.create({
        data: { slaveId: manager.id, kind: 'planning', status: 'failed', startedAt: now, terminalAt: now, endedAt: now },
      })
    }

    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(2)
  })

  it('counts the cap from THIS version, so a further goal edit buys fresh attempts', async (): Promise<void> => {
    const fixture = await boardAt(1)
    const past = new Date(Date.now() - 60_000)
    const manager = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspaceId } } })
    for (let i = 0; i < 2; i += 1) {
      await prisma.slaveRun.create({
        data: { slaveId: manager.id, kind: 'planning', status: 'failed', startedAt: past, terminalAt: past, endedAt: past },
      })
    }
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)

    expect(await dispatchPlanning(depsForReplan(fixture.workspaceId))).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(3)
  }, 60_000)


  /**
   * A succeeded planning run whose RECORDED context says it was a re-plan, and the text it
   * produced -- the shape `concludePlanning` routes on (spec erratum E4), hand-seeded so the
   * conclusion can be driven without a second real run.
   */
  async function seedConcludedReplan(
    fixture: Fixture,
    delta: string,
    boardTaskIds: readonly string[],
    options: { readonly shownRunbook?: string } = {},
  ): Promise<string> {
    const manager = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspaceId } } })
    const now = new Date()
    const run = await prisma.slaveRun.create({
      data: { slaveId: manager.id, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    // The `runbook` section, when the case says this run was shown one: `applyDelta` reads the
    // stage vocabulary off the manifest since M48's final review (Important 3), exactly as
    // `concludePlanning` does, and for the same reason.
    const shown =
      options.shownRunbook === undefined
        ? null
        : await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: options.shownRunbook } })
    await prisma.runContext.create({
      data: {
        runId: run.id,
        prompt: 'the prompt this run was given',
        sections: {
          kind: 'planning',
          sections: [
            {
              kind: 'replan',
              previousVersion: 1,
              version: 2,
              previousSha256: 'previous-hash',
              sha256: 'current-hash',
              boardTaskIds: [...boardTaskIds],
            },
            ...(shown === null
              ? []
              : [
                  {
                    kind: 'runbook',
                    runbookId: shown.id,
                    key: shown.key,
                    stageKeys: (shown.stages as { key: string }[]).map((stage) => stage.key),
                  },
                ]),
          ],
        },
      },
    })
    await prisma.executionEvent.create({
      data: {
        type: 'run_output',
        workspaceId: fixture.workspaceId,
        slaveId: manager.id,
        runId: run.id,
        actor: 'slave',
        payload: { text: delta },
      },
    })
    return run.id
  }

  // E R5, fix round 1: a task a re-plan adds is a task like any other. A board grown by a re-plan
  // whose research task carried no permission would fail exactly as the first-plan one did.
  it('writes the needs of a task a re-plan adds, bounded to the closed list', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[],"needs":["network_fetch","sudo"]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    // `sudo` never reaches the row: `normalisePlanTask` bounds a delta's needs to the same closed
    // list a first plan's are bounded to.
    expect(added.requiredPermissions).toEqual(['network_fetch'])
  })

  it('gives a task the delta adds the seat that holds its role, and says so on task.created (H2)', async (): Promise<void> => {
    const fixture = await boardAt(1)
    const beryl = await prisma.slave.findFirstOrThrow({
      where: { team: { workspaceId: fixture.workspaceId }, runtimeRoles: { has: 'backend' } },
    })
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    // A task a re-plan adds is a task like any other: it arrives with a name on it, by the same
    // rule and the same reading of the seats as a first plan's.
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    expect(added.assigneeId).toBe(beryl.id)

    const created = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'task_created', taskId: added.id },
    })
    expect(created).toHaveLength(1)
    expect(created[0]?.payload).toMatchObject({ title: 'Document the new endpoint', assigneeId: beryl.id })

    // The task the delta KEPT is untouched -- assignment happens at creation, and a re-plan does
    // not re-assign a board it did not create.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: existing.id } })).assigneeId).toBeNull()
  })

  it('routes on the recorded manifest, and lets an addition depend on a task already on the board', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":["${existing.id}"]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    // The public entry point, not `concludeReplan`: a re-plan is told apart from a first plan by
    // this run's own manifest, never by `run.kind` (both are `planning`).
    await concludePlanning(brandRunId(runId))

    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    expect(added.goalVersion).toBe(2)
    // Spec erratum E1: `dependsOn` may name an EXISTING task id, not only a plan-local key.
    expect(await prisma.taskDependency.findMany({ where: { taskId: added.id } })).toEqual([
      { taskId: added.id, dependsOnTaskId: existing.id },
    ])
    // The first-plan path was not taken: it would have written this event (and refused the board).
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_plan_created' } }),
    ).toBe(0)
  })

  // M48 R2, on the delta path: an addition carries the same three things a first plan's task does,
  // and the same adherence is reported -- measured over what the DELTA added, never over the board.
  it('gives an addition its stage, its contract and the stage retry, and reports adherence', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    await syncRunbooks()
    expect((await adoptRunbook(fixture.workspaceId, 'feature-delivery')).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })

    const runId = await seedConcludedReplan(
      fixture,
      JSON.stringify({
        add: [
          {
            key: 'prove',
            title: 'Prove the new endpoint',
            description: 'write the test',
            role: 'backend',
            stage: 'verify',
            handoff: {
              objective: 'Prove the endpoint answers',
              expectedOutput: 'A green verify log naming the endpoint',
              acceptanceCriteria: ['The test fails without the change'],
            },
            dependsOn: [],
          },
        ],
        cancel: [],
        keep: [existing.id],
      }),
      [existing.id],
      { shownRunbook: 'feature-delivery' },
    )

    await concludePlanning(brandRunId(runId))

    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Prove the new endpoint' },
    })
    expect(added.stage).toBe('verify')
    expect(added.handoff).toMatchObject({ objective: 'Prove the endpoint answers' })
    // The verify stage's own retry cap, not the workspace's 3.
    expect(added.maxAttempts).toBe(2)

    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({
      runbook: {
        key: 'feature-delivery',
        stagesCovered: ['verify'],
        stagesMissing: ['design', 'implement', 'review', 'release'],
      },
    })
  })

  it('refuses a delta naming a stage the adopted runbook does not have, and adds nothing', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    await syncRunbooks()
    expect((await adoptRunbook(fixture.workspaceId, 'feature-delivery')).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })

    const runId = await seedConcludedReplan(
      fixture,
      JSON.stringify({
        add: [{ key: 'k', title: 'T', description: 'd', role: 'backend', stage: 'polish', dependsOn: [] }],
        cancel: [],
        keep: [existing.id],
      }),
      [existing.id],
      { shownRunbook: 'feature-delivery' },
    )

    await concludePlanning(brandRunId(runId))

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { runId, type: 'run_failed' } })
    expect((failure.payload as { reason: string }).reason).toContain('names stage "polish"')
  })

  // M48 final review, Important 3, on the delta path: the same swap, the same answer. A re-plan
  // takes minutes too, and a delta refused wholesale over a column somebody moved costs the
  // additions AND the cancellations the manager had worked out.
  it('judges the delta by the runbook the RUN was shown, not the one adopted while it was thinking', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    await syncRunbooks()
    expect((await adoptRunbook(fixture.workspaceId, 'feature-delivery')).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })

    const runId = await seedConcludedReplan(
      fixture,
      JSON.stringify({
        add: [{ key: 'prove', title: 'Prove the new endpoint', description: 'd', role: 'backend', stage: 'verify', dependsOn: [] }],
        cancel: [],
        keep: [existing.id],
      }),
      [existing.id],
      { shownRunbook: 'feature-delivery' },
    )
    // ...and only now does somebody choose a different way of working.
    expect((await adoptRunbook(fixture.workspaceId, 'security-review')).ok).toBe(true)

    await concludePlanning(brandRunId(runId))

    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Prove the new endpoint' },
    })
    expect(added.stage).toBe('verify')
    // The measurement is against `security-review`, the runbook this project follows NOW: its own
    // three other stages are reported missing, and nothing here pretends the delta was written
    // against it.
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({
      runbook: { key: 'security-review', stagesMissing: ['threat-model', 'review', 'remediate'] },
    })
  })

  it('carries no runbook block on workspace.replanned when no runbook is adopted', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      JSON.stringify({
        add: [{ key: 'k', title: 'T', description: 'd', role: 'backend', dependsOn: [] }],
        cancel: [],
        keep: [existing.id],
      }),
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).not.toHaveProperty('runbook')
  })

  it('drops a cancellation for work that FINISHED while the re-plan was thinking, rather than failing the delta', async (): Promise<void> => {
    // Spec §1: a cancellation of a done task is "dropped and recorded". That is only reachable if
    // the parse accepts the id -- a re-plan run takes minutes, and a board read at conclusion is
    // not the board the prompt showed.
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":["${existing.id}"],"keep":[]}`,
      [existing.id],
    )
    await prisma.task.update({ where: { id: existing.id }, data: { status: 'done' } })

    await concludePlanning(brandRunId(runId))

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('succeeded')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toEqual({
      version: 2,
      runId,
      added: [added.id],
      proposedCancellations: [],
      droppedCancellations: [{ taskId: existing.id, status: 'done' }],
      failedProposals: [],
    })
  })

  it('lands its additions anyway when a proposal is refused, and says it proposed nothing', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    // The project switched its Supervisor off: `recordDecision` refuses every proposal. A re-plan
    // whose additions have already landed must not throw over that (M40 §5) -- and must not claim
    // a proposal a human will never see.
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { supervisorEnabled: false } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":["${existing.id}"],"keep":[]}`,
      [existing.id],
    )

    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {})
    try {
      await concludePlanning(brandRunId(runId))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe('backlog')
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toEqual({
      version: 2,
      runId,
      added: [added.id],
      proposedCancellations: [],
      droppedCancellations: [],
      // The Supervisor is off, so the cancellation the model asked for never became a proposal --
      // and says so, rather than vanishing between the three lists.
      failedProposals: [existing.id],
    })
  })

  it('ignores a second conclusion of the same run rather than applying its delta twice', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":["${existing.id}"],"keep":[]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {})
    try {
      await concludePlanning(brandRunId(runId))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    // One addition, one proposal, one event -- not two of each.
    expect(
      await prisma.task.count({ where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' } }),
    ).toBe(1)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(1)
  })

  it('fails the run when the double-conclusion read itself throws, rather than throwing past the pump', async (): Promise<void> => {
    // Final review, Important 1. The three reads before `applyDelta` -- the manifest, the run row
    // and this one -- sat outside the containment under a docblock promising nothing throws past
    // this function. A throw from here would leave the run `succeeded`, the version permanently
    // deduped on `workspace.replan_started`, and nothing on the board: the one outcome the split
    // at the commit exists to prevent. It is a failed ATTEMPT instead, so the retry cap governs.
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    // Only the double-conclusion read: every other `findFirst` on the event log -- including the
    // ones `appendEvent` and the failure path below make -- still runs for real.
    const original = prisma.executionEvent.findFirst
    Object.defineProperty(prisma.executionEvent, 'findFirst', {
      configurable: true,
      writable: true,
      value: (...args: Parameters<typeof original>): unknown => {
        if ((args[0] as { where?: { type?: string } } | undefined)?.where?.type === 'workspace_replanned') {
          throw new Error('the event log could not be read')
        }
        return (original as (...call: Parameters<typeof original>) => unknown).apply(prisma.executionEvent, args)
      },
    })
    try {
      // No `.catch`: the point of the fix is that this resolves.
      await concludePlanning(brandRunId(runId))
    } finally {
      Object.defineProperty(prisma.executionEvent, 'findFirst', { configurable: true, writable: true, value: original })
    }

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain('could not be concluded')
    expect((failures[0]?.payload as { reason: string }).reason).toContain('the event log could not be read')
    // Nothing was applied: the board is the one task it started with, and no re-plan is claimed.
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(0)
  })

  it('fails the run and creates nothing when the additions themselves cannot be written', async (): Promise<void> => {
    // A dependency listed TWICE slips past `validateDelta` (which checks membership, not
    // duplicates) and dies on `TaskDependency`'s primary key inside the transaction. Whatever
    // throws before the additions commit, the answer is the parse-failure answer: fail the run so
    // the retry cap governs -- never leave the version deduped with nothing to show for it.
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":["${existing.id}","${existing.id}"]}],"cancel":[],"keep":[]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain('could not be applied')
    // The transaction rolled back: no half-applied version.
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(0)
  })

  it('keeps going when one proposal THROWS: the others land and the event names both', async (): Promise<void> => {
    // The additions are already on the board by the time proposals are recorded, so a
    // `recordDecision` that throws (a schema or index violation, a database that went away) must
    // cost that ONE cancellation and nothing else -- and must still be written down.
    const fixture = await boardAt(1)
    const doomedFirst = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const doomedSecond = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Polish the docs',
        description: 'tidy up',
        status: 'backlog',
        requiredRole: 'backend',
        maxAttempts: 3,
        goalVersion: 1,
      },
    })
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","role":"backend","dependsOn":[]}],"cancel":["${doomedFirst.id}","${doomedSecond.id}"],"keep":[]}`,
      [doomedFirst.id, doomedSecond.id],
    )
    throwingProposals.add(doomedFirst.id)

    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {})
    try {
      await concludePlanning(brandRunId(runId))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      throwingProposals.clear()
    }

    // The run is a success: it did produce a delta, and the delta was applied.
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded')
    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(decisions.map((decision) => decision.subjectId)).toEqual([doomedSecond.id])
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, title: 'Document the new endpoint' },
    })
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toEqual({
      version: 2,
      runId,
      added: [added.id],
      proposedCancellations: [doomedSecond.id],
      droppedCancellations: [],
      failedProposals: [doomedFirst.id],
    })
  })

  // Fix round 1, Important: the delta path used to commit the same null-role row and fail at
  // NOTHING -- a silently unschedulable task, forever. Refused before the transaction now, where
  // every other pre-commit failure of `applyDelta` goes.
  it('fails the run and adds nothing when an added task asks only for capabilities the taxonomy lacks', async (): Promise<void> => {
    await syncCapabilityTaxonomy()
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"docs","title":"Document the new endpoint","description":"write it","capabilities":["nope.nothing"],"dependsOn":[]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      'planning run produced no valid re-plan delta: added task "docs" asks only for capabilities the taxonomy does not have',
    )
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(0)
  })

  // Task 5, on the delta path: the same hard boundary a first plan is held to, and atomic in the
  // same way -- a bad delta must not land its additions while dropping its cancellations, or the
  // reverse. `applyDelta` returns the failure BEFORE its own transaction, so nothing here is a
  // partial application.
  it('fails the run and writes no additions, cancellations or proposals when an added task names an unstaffed role', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    // `boardAt` staffs `backend` only -- `design` is not a role anybody on this project carries.
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"palette","title":"Pick a palette","description":"d","role":"design","dependsOn":[]}],"cancel":["${existing.id}"],"keep":[]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    const reason = (failures[0]?.payload as { reason: string }).reason
    expect(reason).toContain('"palette"')
    expect(reason).toContain('Pick a palette')
    expect(reason).toContain('role "design"')

    // Atomic: no addition landed, the cancellation the delta asked for was never proposed, and the
    // task it would have cancelled is untouched.
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe('backlog')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(0)
  })

  it('passes a delta addition whose role is carried only by a BUSY seat', async (): Promise<void> => {
    const fixture = await boardAt(1)
    const busy = await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        role: 'design',
        runtimeRoles: ['design'],
        personId: (await prisma.person.create({ data: { name: `Busy ${randomUUID()}` } })).id,
      },
    })
    await prisma.slaveRun.create({ data: { slaveId: busy.id, kind: 'implementation', status: 'working' } })
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)
    const existing = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const runId = await seedConcludedReplan(
      fixture,
      `{"add":[{"key":"palette","title":"Pick a palette","description":"d","role":"design","dependsOn":[]}],"cancel":[],"keep":["${existing.id}"]}`,
      [existing.id],
    )

    await concludePlanning(brandRunId(runId))

    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded')
    const added = await prisma.task.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId, title: 'Pick a palette' } })
    expect(added.requiredRole).toBe('design')
    // H2: and it is THEIRS. A busy holder is still the holder -- the task waits for them rather
    // than for nobody.
    expect(added.assigneeId).toBe(busy.id)
  })

  it('fails the run and changes no board when the re-plan output carries no valid delta', async (): Promise<void> => {
    const fixture = await boardAt(1)
    expect((await setGoal(fixture.workspaceId, V2)).ok).toBe(true)

    // A fixture that replays a review verdict: a succeeded process that said nothing a delta can
    // be read out of, which is a failed planning attempt and not an infrastructure problem.
    const runId = await dispatchPlanning(depsFor(fixture.workspaceId, 'review-invalid'))
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId as string } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain('no valid re-plan delta')

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_replanned' } }),
    ).toBe(0)
  }, 60_000)
})
