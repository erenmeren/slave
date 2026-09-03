import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refusalText } from '@ai-team-os/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@ai-team-os/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPlanningPrompt, concludePlanning, dispatchPlanning } from '../../src/planning.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository: the planning run's `worktreePath` is the primary checkout itself. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-planning-'))
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

async function seed(goal: string | null): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      goal,
    },
  })
  // M12 Task 8: no agent in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here refuses instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id, repoPath }
}

async function addManager(teamId: string, name = 'Atlas'): Promise<string> {
  const agent = await prisma.agent.create({ data: { teamId, name, role: 'manager' } })
  return agent.id
}

/** A `backend` agent -- the role every task the `plan-graph` fixture describes requires. */
async function addBackendAgent(teamId: string, name = 'Beryl'): Promise<string> {
  const agent = await prisma.agent.create({ data: { teamId, name, role: 'backend' } })
  return agent.id
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
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'planning' } })
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
    await prisma.agent.update({ where: { id: managerId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 20 } })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'planning' } })
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
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('(c) starts nothing with no goal set', async (): Promise<void> => {
    const fixture = await seed(null)
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(0)
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
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(1)
  })

  it('(e) escalates once with no manager-role agent in the workspace, and starts nothing', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    // No manager-role agent exists.

    const first = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(first).toBeNull()

    const second = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(second).toBeNull()

    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noPlannerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_planner',
    )
    expect(noPlannerEvents).toHaveLength(1)
    expect(noPlannerEvents[0]?.taskId).toBeNull()
  })

  it('(f) starts nothing once two planning runs newer than the goal have failed', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)

    const now = new Date()
    await prisma.agentRun.create({
      data: {
        agentId: managerId,
        kind: 'planning',
        status: 'failed',
        startedAt: now,
        terminalAt: now,
        endedAt: now,
      },
    })
    await prisma.agentRun.create({
      data: {
        agentId: managerId,
        kind: 'planning',
        status: 'failed',
        startedAt: now,
        terminalAt: now,
        endedAt: now,
      },
    })

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(runId).toBeNull()
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(2)
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
      await prisma.agentRun.create({
        data: { agentId: managerId, kind: 'planning', status: 'failed', startedAt: past, terminalAt: past, endedAt: past },
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
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(3)
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
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'planning' } })
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
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
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

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId as string } })
    expect(run.status).toBe('succeeded')

    const tasks = await prisma.task.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(tasks).toHaveLength(3)
    for (const task of tasks) {
      expect(task.requiredRole).toBe('backend')
      expect(task.createdBy).toBe('agent')
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
    expect(planCreated[0]?.agentId).toBe(run.agentId)
    const payload = planCreated[0]?.payload as unknown as { goal: string; tasks: readonly { title: string }[] }
    expect(payload.goal).toBe('Ship the checkout redesign')
    expect(payload.tasks.map((task) => task.title).sort()).toEqual(
      ['Document and polish', 'Expose the API', 'Write the feature core'].sort(),
    )
  })

  it('(b) a subsequent dispatchPlanning starts nothing once the graph became the board', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const first = await dispatchPlanning(depsFor(fixture.workspaceId))
    expect(first).not.toBeNull()
    await drainPumps()
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)

    const second = await dispatchPlanning(depsFor(fixture.workspaceId))

    expect(second).toBeNull()
    expect(await prisma.agentRun.count({ where: { kind: 'planning' } })).toBe(1)
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)
  })

  it('(c) fails the run and creates no tasks when the planning output carries no valid graph', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)

    const runId = await dispatchPlanning(depsFor(fixture.workspaceId, 'review-invalid'))
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId as string } })
    expect(run.status).toBe('failed')

    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain(
      'planning run produced no valid task graph',
    )

    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
  })

  it('(d) warns and creates no NEW tasks when the board grew a task before conclusion', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    const managerId = await addManager(fixture.teamId)

    const now = new Date()
    const run = await prisma.agentRun.create({
      data: { agentId: managerId, kind: 'planning', status: 'succeeded', startedAt: now, terminalAt: now, endedAt: now },
    })
    await prisma.executionEvent.create({
      data: {
        type: 'run_output',
        workspaceId: fixture.workspaceId,
        agentId: managerId,
        runId: run.id,
        actor: 'agent',
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

  it('(e) the daemon-shape follow-through: a further tick starts an implementation run for the root task', async (): Promise<void> => {
    const fixture = await seed('Ship the checkout redesign')
    repos.push(fixture.repoPath)
    await addManager(fixture.teamId)
    await addBackendAgent(fixture.teamId)
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
})

describe('buildPlanningPrompt', () => {
  it('(g) contains the task-graph marker and the goal text', () => {
    const prompt = buildPlanningPrompt('Ship the checkout redesign')

    expect(prompt).toContain('"task graph"')
    expect(prompt).not.toContain('"verdict"')
    expect(prompt).toContain('Ship the checkout redesign')
  })
})
