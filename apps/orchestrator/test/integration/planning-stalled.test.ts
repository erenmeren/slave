import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGoal, workspaceStats } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { PLANNING_RETRY_CAP, SUPERVISOR_DEFAULT_PROVIDER, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

/**
 * H4a + H4b, end to end through the daemon's own `tick`: planning that cannot start is a situation
 * the Supervisor resolves, and what it resolves it WITH actually works on the next tick.
 *
 * The project of 2026-09-21, fact for fact: a goal, a manager, and no runtime. Two planning runs
 * failed in the same second at spawn ("no runtime could be resolved"), the retry cap read them as
 * two failures of the planner, and nothing could re-plan -- for ever, silently. Two things had to
 * be true for that to stop, and each half of this file proves one of them against real rows:
 *
 *  1. A run that never reached the model spends nothing (`SlaveRun.spawnFailed`), so once the
 *     Supervisor's `configure_runtime` gives the project a runtime, the very next tick plans.
 *  2. A cap spent by REAL failures is given back exactly once per goal version
 *     (`retry_planning` -> `workspace.planning_reset`), and a second spend is a person's call.
 *
 * Nothing is stubbed: `tick` dispatches, the fake CLI answers (or fails to), `supervise` reads the
 * world `loadSupervisorWorld` builds and carries its decision out through `applyDecision`. No
 * model seam is wired -- the rules choose, exactly as a daemon with no decider does.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

/** Two clocks for the Supervisor, further apart than `COOLDOWN_MS` (15 min): the second decision
 *  on one situation key must not be swallowed as a repeat of the first. */
const T1 = new Date('2026-09-21T10:00:00.000Z')
const T2 = new Date('2026-09-21T10:20:00.000Z')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-planning-stalled-'))
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
  readonly repoPath: string
}

/**
 * A project under `act`, staffed to plan and to build, with a goal -- and a runtime only when the
 * case says so. `consecutiveFailureLimit` is raised well past anything here: this file is about
 * the PLANNING cap, and the breaker halting the project over four real planning failures would be
 * a second story told in the middle of this one.
 */
async function seed(options: { readonly runtime: boolean }): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      supervisorAutonomy: 'act',
      consecutiveFailureLimit: 10,
    },
  })
  if (options.runtime) {
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  }
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.slave.create({
    data: {
      teamId: team.id,
      role: 'Engineering Lead',
      runtimeRoles: ['manager'],
      personId: (await prisma.person.create({ data: { name: 'Atlas' } })).id,
    },
  })
  // The plan-graph fixture writes every task with `role: 'backend'`, and conclusion refuses a
  // board naming a role nobody can serve.
  await prisma.slave.create({
    data: {
      teamId: team.id,
      role: 'backend',
      runtimeRoles: ['backend'],
      personId: (await prisma.person.create({ data: { name: 'Beryl' } })).id,
    },
  })
  expect((await setGoal(workspace.id, 'Ship the checkout redesign')).ok).toBe(true)
  return { workspaceId: workspace.id, repoPath }
}

function singleAdapterRegistry(adapter: ClaudeCodeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

/** `deps` for a tick. `fixture` is what the fake CLI answers a planning prompt with: `m8-flow`
 *  replays a real task graph, `review-invalid` replays something no graph can be parsed out of --
 *  a run that REACHED the model and failed, which is what a real planning failure is. */
function depsFor(workspaceId: string, fixture: 'm8-flow' | 'review-invalid', now: Date): TickDeps {
  return {
    workspaceId: brandWorkspaceId(workspaceId),
    registry: singleAdapterRegistry(
      new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', fixture], hookPath: REAL_GATE }),
    ),
    now: () => now,
  }
}

const planningRuns = (workspaceId: string) =>
  prisma.slaveRun.findMany({
    where: { kind: 'planning', slave: { team: { workspaceId } } },
    orderBy: { startedAt: 'asc' },
  })

const decisions = (workspaceId: string) =>
  prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

const actionKind = (row: { readonly action: unknown }): string | undefined => (row.action as { kind?: string }).kind

describe('planning that cannot start, end to end through the tick (H4a/H4b)', () => {
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('gives a project with no runtime one, and the next tick plans -- the spawn failure spent nothing', async (): Promise<void> => {
    const fixture = await seed({ runtime: false })
    repos.push(fixture.repoPath)

    // ---- Tick 1: planning fails before the model is asked, and the Supervisor answers it -----
    const first = await tick(depsFor(fixture.workspaceId, 'm8-flow', T1))
    expect(first.planningStarted).toBeNull()
    expect(first.halted).toBeNull()

    const failed = (await planningRuns(fixture.workspaceId))[0]!
    expect(failed).toMatchObject({ status: 'failed', spawnFailed: true, pid: null })
    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { runId: failed.id, type: 'run_failed' } })
    expect(failure.payload).toMatchObject({ phase: 'spawn' })
    expect((failure.payload as { reason: string }).reason).toContain('no runtime could be resolved')

    // The remedy, applied by the Supervisor itself in the same tick: `planning_stalled/no_runtime`
    // was raised (the failure did not read as a planner that cannot plan) and `configure_runtime`
    // was carried out, not proposed.
    expect(first.supervisor).toMatchObject({ decided: 1, applied: 1, proposed: 0, modelCalls: 0 })
    const [decision] = await decisions(fixture.workspaceId)
    expect(actionKind(decision!)).toBe('configure_runtime')
    expect(decision).toMatchObject({ status: 'applied', tier: 'applied' })
    expect(decision?.situation).toMatchObject({ kind: 'planning_stalled', subjectId: `${fixture.workspaceId}:no_runtime` })
    expect(await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspaceId } })).toMatchObject([
      { kind: SUPERVISOR_DEFAULT_PROVIDER },
    ])
    // And the breaker saw no failure at all: a missing runtime is not a worker failing.
    expect((await workspaceStats(fixture.workspaceId)).stats.consecutiveFailures).toBe(0)

    // ---- Tick 2: planning starts, because the spawn failure never counted --------------------
    const second = await tick(depsFor(fixture.workspaceId, 'm8-flow', T1))
    expect(second.planningStarted).not.toBeNull()
    await drainPumps()

    const runs = await planningRuns(fixture.workspaceId)
    expect(runs.map((run) => [run.status, run.spawnFailed])).toEqual([
      ['failed', true],
      ['succeeded', false],
    ])
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(3)
    // Nobody was asked anything on the way.
    expect((await decisions(fixture.workspaceId)).filter((row) => row.status === 'pending')).toHaveLength(0)
  }, 60_000)

  it('gives a cap spent by real failures back once, and asks a person when it is spent again', async (): Promise<void> => {
    const fixture = await seed({ runtime: true })
    repos.push(fixture.repoPath)
    const broken = depsFor(fixture.workspaceId, 'review-invalid', T1)

    // ---- Two REAL failures: the model ran and produced nothing a board could be made of ------
    for (let attempt = 0; attempt < PLANNING_RETRY_CAP; attempt += 1) {
      expect((await tick(broken)).planningStarted).not.toBeNull()
      await drainPumps()
    }
    const spent = await planningRuns(fixture.workspaceId)
    expect(spent).toHaveLength(PLANNING_RETRY_CAP)
    expect(spent.every((run) => run.status === 'failed' && !run.spawnFailed)).toBe(true)
    expect(await prisma.task.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)

    // ---- Tick 3: the cap is spent, and the Supervisor gives it back, once ---------------------
    const third = await tick(broken)
    expect(third.planningStarted).toBeNull()
    expect(third.supervisor).toMatchObject({ decided: 1, applied: 1, proposed: 0 })
    const [reset] = await decisions(fixture.workspaceId)
    expect(actionKind(reset!)).toBe('retry_planning')
    expect(reset).toMatchObject({ status: 'applied', tier: 'applied' })
    expect(reset?.situation).toMatchObject({ kind: 'planning_stalled', subjectId: `${fixture.workspaceId}:cap_spent` })
    const resets = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'workspace_planning_reset' },
    })
    expect(resets).toHaveLength(1)
    expect(resets[0]?.payload).toEqual({ version: 1, by: 'supervisor' })

    // ---- The count starts again: planning is re-dispatched, and fails twice more for real ----
    for (let attempt = 0; attempt < PLANNING_RETRY_CAP; attempt += 1) {
      expect((await tick(broken)).planningStarted).not.toBeNull()
      await drainPumps()
    }
    expect(await planningRuns(fixture.workspaceId)).toHaveLength(2 * PLANNING_RETRY_CAP)

    // ---- Tick 6, after the cooldown: spent again, and this time a person decides ------------
    const sixth = await tick(depsFor(fixture.workspaceId, 'review-invalid', T2))
    expect(sixth.planningStarted).toBeNull()
    expect(sixth.supervisor).toMatchObject({ decided: 1, applied: 0, proposed: 1 })
    const latest = (await decisions(fixture.workspaceId)).at(-1)
    expect(actionKind(latest!)).toBe('escalate_to_human')
    expect(latest).toMatchObject({ status: 'pending', tier: 'escalated' })
    expect(latest?.situation).toMatchObject({ kind: 'planning_stalled', subjectId: `${fixture.workspaceId}:cap_spent` })
    // Exactly one reset for this goal, still: the second spend gave nothing back.
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'workspace_planning_reset' } }),
    ).toBe(1)
    expect(await planningRuns(fixture.workspaceId)).toHaveLength(2 * PLANNING_RETRY_CAP)
  }, 120_000)
})
