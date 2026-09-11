import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refusalText } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { concludeReview, dispatchReviews } from '../../src/review.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, because `dispatchReviews` runs real `git diff` against it. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-review-'))
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
  readonly taskId: string
  readonly slaveId: string
  readonly repoPath: string
}

async function seed(): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  // M12 Task 8: no slave in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here refuses instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id, repoPath }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

/**
 * `deps.registry` for a test that only ever runs against one adapter instance (the ordinary case
 * pre-Task-8, when every run resolves to `'claude_code'` regardless of what `kind` is asked for).
 */
function singleAdapterRegistry(adapter: ClaudeCodeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

/**
 * Drives a real `tick` with the `complete` fixture to give the seeded task a real worktree, branch
 * and a `succeeded` implementation run -- landing it in `reviewing` the way production does since
 * Task 8's flip (verify green enters review directly; nothing here parks it there by hand anymore).
 * Cheaper and more real than hand-provisioning a worktree and forging a `SlaveRun` row: this is the
 * exact shape `dispatchReviews` will actually see in production.
 */
async function seedReviewingTask(fixture: Fixture, reviewFixture = 'review-approve'): Promise<TickDeps> {
  const implDeps: TickDeps = {
    workspaceId: brandWorkspaceId(fixture.workspaceId),
    registry: singleAdapterRegistry(
      new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE }),
    ),
  }
  const report = await tick(implDeps)
  expect(report.started).toHaveLength(1)
  await drainPumps()

  const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
  // Sanity: the seeding tick actually landed a real branch + worktree, and verify's green branch
  // (Task 8) put it exactly where `dispatchReviews` looks.
  expect(task.status).toBe('reviewing')

  return {
    workspaceId: brandWorkspaceId(fixture.workspaceId),
    registry: singleAdapterRegistry(
      new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', reviewFixture], hookPath: REAL_GATE }),
    ),
  }
}

/**
 * Adds a slave staffable as a reviewer to the fixture's one team, idle and ready to be picked up.
 *
 * Its TITLE is deliberately not "reviewer" (M37 t3): staffing matches `runtimeRoles`, so a fixture
 * where the two agreed would pass whichever column `dispatchReview` happened to read.
 */
async function addReviewer(): Promise<void> {
  const team = await prisma.team.findFirstOrThrow()
  await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })
}

async function eventsOf(
  workspaceId: string,
  dbType: 'task_review_approved' | 'task_review_rejected',
): Promise<readonly { payload: unknown }[]> {
  return prisma.executionEvent.findMany({ where: { workspaceId, type: dbType }, orderBy: { seq: 'asc' } })
}

describe('dispatchReviews', () => {
  let fixture: Fixture
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    repos.push(fixture.repoPath)
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('starts a review run for a reviewing task with an idle reviewer', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toHaveLength(1)
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.kind).toBe('review')
    expect(run.taskId).toBe(fixture.taskId)

    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.review_started')

    await drainPumps()
    const events = await prisma.executionEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } })
    expect(events.map((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type])).toContain('run.output')
  })

  it('refuses with the spec-verbatim unmeasurable_budget text when a budgeted workspace resolves a cost-blind runtime', async (): Promise<void> => {
    // The third dispatch site (M12 Task 9, ruling R9). The budget is a property of the WORKSPACE,
    // so it governs a review run exactly as it governs an implementation or a planning one --
    // leaving one site unchecked would leave a way to spend unmeasured money inside a budget.
    //
    // Seeded first, then made cost-blind: the implementation run that puts the task in `reviewing`
    // has to succeed under the ordinary configuration, or this would be testing that a task never
    // reached review rather than that the review itself was refused.
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    const reviewer = await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })
    await prisma.slave.update({ where: { id: reviewer.id }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 20 } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'unmeasurable_budget', workspaceId: fixture.workspaceId, provider: 'cursor' }),
    )
  })

  it('starts nothing a second time while the review run it started is still live', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)

    const second = await dispatchReviews(reviewDeps)

    expect(second).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(1)
  })

  // M41 Task 3b, the race the scenario gate measured five times in seven runs. Check 1 above is a
  // COUNT of live review runs, and neither of two overlapping passes can see the other's row before
  // it is committed -- so both used to reach the dispatch and put two reviewers on one branch, one
  // of them billed for nothing. `Promise.all` is the same overlap the daemon produces for free: the
  // review run's own `run.succeeded` wakes the tick coalescer, and the CLI's `tick` can run against
  // a live daemon at any moment.
  it('starts exactly one review run when two dispatch passes race for the same task', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    await addReviewer()

    const [first, second] = await Promise.all([dispatchReviews(reviewDeps), dispatchReviews(reviewDeps)])

    // Read before anything else: the winner's pump is live, and an approve conclusion would move
    // the task off the claim.
    const runs = await prisma.slaveRun.findMany({ where: { kind: 'review' } })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })

    // The primary signal, and the one that is not racing anything: one dispatch started a review,
    // the other started nothing, and the loser left no `SlaveRun` row behind -- a `failed` row here
    // would read as a review attempt against `REVIEW_RETRY_CAP` for a run that never spawned.
    expect([...first, ...second]).toHaveLength(1)
    expect(runs).toHaveLength(1)

    // Two legitimate end states, because the winner's pump IS racing this read: either the review is
    // still live and the task carries its claim, or the pump has already concluded an approve and
    // the task moved to `merging` with the claim released. Both say a review run owns this task.
    // What neither of them is -- and what this whole task exists to stop -- is the third state: a
    // `reviewing` task with no claim, which is the state the second reviewer was dispatched from.
    const ownership =
      task.status === 'reviewing' && task.activeRunId === runs[0]?.id
        ? 'claimed by the live review'
        : task.status === 'merging' && task.activeRunId === null
          ? 'concluded and released'
          : `${task.status} with activeRunId ${String(task.activeRunId)}`
    expect(['claimed by the live review', 'concluded and released']).toContain(ownership)

    await drainPumps()
    const startedEvents = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'task_review_started' },
    })
    expect(startedEvents).toHaveLength(1)
  }, 60_000)

  // The production shape of the same race, reproduced from the daemon's side rather than by two
  // overlapping calls: `pumpRun` writes the review run terminal and emits `run.succeeded` BEFORE the
  // chained `verifyConcludedRun` -> `concludeReview` moves the task off `reviewing`, and `runDaemon`
  // wakes its tick coalescer on EVERY event. So the review's own success is what dispatches its
  // replacement, 16-45 ms later.
  it('starts no second reviewer in the window where run.succeeded is written but the conclusion has not moved the task', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    await addReviewer()

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)

    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    const now = new Date()
    // `count` is a precondition, not decoration: this write has to be the one that closes the run,
    // or the pump got there first and the test is looking at a window that has already shut.
    const terminal = await prisma.slaveRun.updateMany({
      where: { id: run.id, endedAt: null },
      data: { status: 'succeeded', terminalAt: now, endedAt: now },
    })
    expect(terminal.count).toBe(1)
    await appendEvent({
      type: 'run.succeeded',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: { numTurns: 1, costUsd: null },
    })

    // The tick that event wakes. The task is still `reviewing` and no review run is non-terminal,
    // so check 1 waves it through -- the claim is the only thing standing between this and a second
    // billed reviewer on the same branch.
    const second = await dispatchReviews(reviewDeps)
    expect(second).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(1)

    // And the conclusion still lands afterwards, releasing the claim it was holding.
    await drainPumps()
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('merging')
    expect(task.activeRunId).toBeNull()
  }, 60_000)

  it('warns once, not once per tick, for a reviewing task with no usable implementation run', async (): Promise<void> => {
    // No `seedReviewingTask`: that drives a real implementation run, which is exactly the thing
    // this task must NOT have. Flipping the fixture's own `ready` task straight to `reviewing`
    // reproduces the stuck state directly -- no implementation run ever recorded for it.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })
    const deps: TickDeps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(
        new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'review-approve'], hookPath: REAL_GATE }),
      ),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await dispatchReviews(deps)
    await dispatchReviews(deps)

    const matching = warn.mock.calls.filter(([msg]) => String(msg).includes('no usable implementation run'))
    expect(matching).toHaveLength(1)
    warn.mockRestore()
  })

  it('escalates once with no reviewer-role slave in the workspace, and starts nothing', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    // No reviewer-role slave exists -- only the `backend` slave `seed()` created.

    const first = await dispatchReviews(reviewDeps)
    expect(first).toEqual([])

    const second = await dispatchReviews(reviewDeps)
    expect(second).toEqual([])

    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noReviewerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_reviewer',
    )
    expect(noReviewerEvents).toHaveLength(1)
  })

  // M37 t3, the other half of the staffing change: a slave whose TITLE is literally "reviewer"
  // but whose runtime role set is empty is not a candidate. Before M37 this row was the only kind
  // of reviewer there was; now it is a parked worker, and staffing it would put a run in front of
  // somebody an operator has deliberately taken out of rotation.
  it('never staffs a slave titled reviewer whose runtime role set is empty', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Parked', role: 'reviewer', runtimeRoles: [] } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    expect(
      guardrails.filter((event) => (event.payload as { guardrail?: string }).guardrail === 'no_reviewer'),
    ).toHaveLength(1)
  }, 60_000)

  it('starts nothing once two review runs newer than the implementation run have failed', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })
    const reviewer = await prisma.slave.findFirstOrThrow({ where: { runtimeRoles: { has: 'reviewer' } } })

    const latestImpl = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'implementation' } })
    const after = (offsetMs: number): Date => new Date(latestImpl.startedAt.getTime() + offsetMs)
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: reviewer.id,
        kind: 'review',
        status: 'failed',
        startedAt: after(1_000),
        terminalAt: after(2_000),
        endedAt: after(2_000),
      },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: reviewer.id,
        kind: 'review',
        status: 'failed',
        startedAt: after(3_000),
        terminalAt: after(4_000),
        endedAt: after(4_000),
      },
    })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(2)
  })

  it('concludes the run failed instead of throwing when the diff itself cannot be produced', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] } })
    // A branch recorded on the task but gone from git itself -- the step-2 null check cannot catch
    // it, so the dispatch reaches `git diff` and the diff fails.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { branch: 'no-such-branch' } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.status).toBe('failed')
    expect(run.terminalAt).not.toBeNull()
    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    // M41 Task 3b: the dispatch claimed the task before it tried to spawn, so a spawn that failed
    // has to hand the claim back -- a `reviewing` task pointing at a terminal run is one no later
    // dispatch could ever claim, which would make this failed review the last one it ever got.
    expect(task.activeRunId).toBeNull()
  })

  it('approves: moves the task to merging and records the reason', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-approve')
    await addReviewer()

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)
    await drainPumps()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('merging')
    // M41 Task 3b: the claim is released in the SAME write as the status, so a task that is no
    // longer under review never carries a review run's claim into `merging` -- where
    // `cancelTask`/`unblockTask`/`failTask` would refuse an operator on the strength of it.
    expect(task.activeRunId).toBeNull()

    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.status).toBe('succeeded')

    const approved = await eventsOf(fixture.workspaceId, 'task_review_approved')
    expect(approved).toHaveLength(1)
    expect((approved[0]?.payload as { reason: string }).reason).toBe(
      'The diff implements the task as described and the tests cover it.',
    )
  })

  it('rejects: sends the task back to rework with the reason and increments attempt', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-reject')
    await addReviewer()

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)
    await drainPumps()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
    expect(task.lastRejectionReason).toBe('The diff does not handle the empty-input case the task requires.')

    const rejected = await eventsOf(fixture.workspaceId, 'task_review_rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.payload).toEqual({
      reason: 'The diff does not handle the empty-input case the task requires.',
      attempt: 1,
    })
  })

  it('ignores a replayed reject conclusion: no second attempt charged, no duplicate event', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-reject')
    await addReviewer()

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)
    await drainPumps()

    // The run row stays `succeeded` after a reject, so a crashed-and-restarted daemon (or any
    // duplicate pump settlement) can legally call the conclusion again for the same run.
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    await concludeReview(brandRunId(run.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
    expect(await eventsOf(fixture.workspaceId, 'task_review_rejected')).toHaveLength(1)
  })

  it('rejects at the attempt cap: fails the task instead of sending it back', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-reject')
    await addReviewer()
    const before = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: before.maxAttempts - 1 } })

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)
    await drainPumps()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('failed')
    expect(task.attempt).toBe(before.maxAttempts)

    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.failed')
    const rejected = await eventsOf(fixture.workspaceId, 'task_review_rejected')
    expect(rejected).toHaveLength(1)
  })

  it('invalid verdict: fails the run, leaves the task in reviewing, and the cap stops a third dispatch', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-invalid')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()

    const firstRun = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(firstRun.status).toBe('failed')
    const afterFirst = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(afterFirst.status).toBe('reviewing')
    // M41 Task 3b: an invalid verdict leaves the task where it is (this branch's policy) but hands
    // the claim back, or the second dispatch below could never take it.
    expect(afterFirst.activeRunId).toBeNull()

    const firstFailure = await prisma.executionEvent.findMany({ where: { runId: firstRun.id, type: 'run_failed' } })
    expect(firstFailure).toHaveLength(1)
    expect((firstFailure[0]?.payload as { reason: string }).reason).toContain('no valid verdict')

    // Second dispatch+conclusion with the same invalid fixture: reaches the cap (Task 5), still reviewing.
    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    await drainPumps()

    const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(afterSecond.status).toBe('reviewing')
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(2)
    expect(await prisma.slaveRun.count({ where: { kind: 'review', status: 'failed' } })).toBe(2)

    // No third dispatch: the retry cap bounds it.
    const third = await dispatchReviews(reviewDeps)
    expect(third).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(2)
  })

  it('escalates an exhausted review cap to blocked instead of leaving the task silently in reviewing', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-invalid')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()

    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    await drainPumps()

    const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    // The design intent `review.test.ts` already pins: an individual review failure -- even the one
    // that brings the count level with the cap -- leaves the task in `reviewing` for the pump that
    // concluded it. The cap is enforced on the NEXT dispatch attempt, not retroactively here.
    expect(afterSecond.status).toBe('reviewing')

    // Fix round 1: the park is guarded on the claim being free. Put the task back in the measured
    // window first -- the second review run is terminal but its conclusion has not landed, so the
    // task still carries its claim -- and the tick that window wakes must NOT park a task whose
    // live review is about to conclude.
    const reviewRuns = await prisma.slaveRun.findMany({ where: { kind: 'review' }, orderBy: { startedAt: 'asc' } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: reviewRuns[1]?.id ?? null } })

    const parkedUnderClaim = await dispatchReviews(reviewDeps)
    expect(parkedUnderClaim).toEqual([])
    const stillReviewing = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(stillReviewing.status).toBe('reviewing')
    expect(
      await prisma.executionEvent.count({
        where: { workspaceId: fixture.workspaceId, taskId: fixture.taskId, type: 'guardrail_tripped' },
      }),
    ).toBe(0)

    // The conclusion lands and releases the claim. NOW the cap parks it.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: null } })

    // Third dispatch: the cap is exhausted. No new review run starts, and the task must not be left
    // silently in `reviewing` forever -- this is the strand M35 Task 4 closes.
    const third = await dispatchReviews(reviewDeps)
    expect(third).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(2)

    const afterThird = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(afterThird.status).toBe('blocked')

    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, taskId: fixture.taskId, type: 'guardrail_tripped' },
    })
    const capEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'review_retry_cap_exhausted',
    )
    expect(capEvents).toHaveLength(1)
    expect((capEvents[0]?.payload as { detail: string }).detail).toContain('2')

    // A fourth dispatch is a no-op: `blocked` is not `reviewing`, so `dispatchReviews` no longer
    // even considers the task, and the escalation event is not written a second time.
    const fourth = await dispatchReviews(reviewDeps)
    expect(fourth).toEqual([])
    expect(
      await prisma.executionEvent.count({
        where: { workspaceId: fixture.workspaceId, taskId: fixture.taskId, type: 'guardrail_tripped' },
      }),
    ).toBe(1)
  })

  it('recovers after one invalid verdict when the next review approves', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-invalid')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()

    const midTask = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(midTask.status).toBe('reviewing')

    const approveDeps: TickDeps = {
      workspaceId: reviewDeps.workspaceId,
      registry: singleAdapterRegistry(
        new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'review-approve'], hookPath: REAL_GATE }),
      ),
    }
    const second = await dispatchReviews(approveDeps)
    expect(second).toHaveLength(1)
    await drainPumps()

    const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(finalTask.status).toBe('merging')
  })

  // M41 Task 3b. Every release in `concludeReview` is guarded on the run id, and this is the case
  // that guard is for: a review run's row stays terminal after it concludes, so a restarted daemon
  // (or a duplicate pump settlement) can legally conclude it a second time -- long after a
  // replacement review has claimed the task. An unguarded release would hand that replacement's
  // task to a third reviewer.
  it('a replayed conclusion cannot clear a newer review run claim', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-invalid')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()
    const firstRun = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })

    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    const secondRunId = second[0]
    const claimed = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(claimed.activeRunId).toBe(secondRunId)

    await concludeReview(brandRunId(firstRun.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.activeRunId).toBe(secondRunId)
    expect(task.status).toBe('reviewing')

    await drainPumps()
  }, 60_000)

  // Fix round 1, the approve half of the same guard: an older run's approval must not march a task
  // whose review is still live into `merging`, nor clear that live review's claim on the way past.
  it('a replayed approve conclusion cannot move a task a newer review run has claimed', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-approve')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()
    const firstRun = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('merging')

    // Back under review -- the shape a rejected-then-reworked-then-verified task arrives in -- and a
    // real dispatch takes the new claim.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })
    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    const secondRunId = second[0]

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await concludeReview(brandRunId(firstRun.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBe(secondRunId)
    // And no second approval announced for a task that was never approved twice.
    expect(await eventsOf(fixture.workspaceId, 'task_review_approved')).toHaveLength(1)
    // The dropped verdict is warned about, not silently discarded (fix round 2): the operator can
    // see which run's approval never took, and against which task/status/claim it collided.
    const dropped = warn.mock.calls.filter(([msg]) => String(msg).includes('dropping an approve verdict'))
    expect(dropped).toHaveLength(1)
    const message = String(dropped[0]?.[0])
    expect(message).toContain(fixture.taskId)
    expect(message).toContain(firstRun.id)
    expect(message).toContain('reviewing')
    expect(message).toContain(secondRunId)
    warn.mockRestore()

    await drainPumps()
  }, 60_000)

  // Fix round 1. `rejectTask` writes `activeRunId: null` unconditionally -- it has to, because
  // `verify.ts`'s other callers reject a task whose claim is an implementation run's -- so the guard
  // that keeps an older run's verdict off a replacement review's task lives at `concludeReview`'s
  // call site. Without it, a replayed reject charges a second attempt AND clears a live reviewer's
  // claim, which is the double-reviewer bug again with a rejection in front of it.
  it('a replayed reject conclusion charges nothing and leaves a newer review run claim intact', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-reject')
    await addReviewer()

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)
    await drainPumps()
    const firstRun = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'review' } })

    // The reject sent the task to `rework`; a fresh implementation run and a green verify would put
    // it back in `reviewing` for a second review. Put it there directly -- this test is about the
    // replay, not about the round trip -- and let a real dispatch take the new claim.
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'reviewing', attempt: 0, lastRejectionReason: null },
    })
    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    const secondRunId = second[0]

    await concludeReview(brandRunId(firstRun.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBe(secondRunId)
    expect(task.attempt).toBe(0)
    // The first run's own rejection event stands; the replay adds no second one.
    expect(await eventsOf(fixture.workspaceId, 'task_review_rejected')).toHaveLength(1)

    await drainPumps()
  }, 60_000)

  // M41 Task 3b. The loser of the claim race must leave NOTHING behind: a `failed` row here would
  // read as a review attempt against `REVIEW_RETRY_CAP`, so two lost races would park a perfectly
  // reviewable task `blocked` for something that never even spawned.
  it('leaves no run row behind when it loses the claim', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    await addReviewer()

    // The exact shape of the measured window: a review run that is terminal (so check 1's count of
    // NON-terminal runs waves the dispatch through) but whose conclusion has not moved the task, so
    // the claim is still held.
    const latestImpl = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'implementation' } })
    const reviewer = await prisma.slave.findFirstOrThrow({ where: { runtimeRoles: { has: 'reviewer' } } })
    const holder = await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: reviewer.id,
        kind: 'review',
        status: 'succeeded',
        startedAt: new Date(latestImpl.startedAt.getTime() + 1_000),
        terminalAt: new Date(latestImpl.startedAt.getTime() + 2_000),
        endedAt: new Date(latestImpl.startedAt.getTime() + 2_000),
      },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: holder.id } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'task_review_started' } }),
    ).toBe(0)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.activeRunId).toBe(holder.id)
  })
})

/**
 * M49 R2(d), plan erratum E2: a rejected review teaches the worker whose diff was turned down --
 * never the reviewer that caught it.
 *
 * In-process: the verdict is fed to `concludeReview` as the `run.output` events a real review run
 * leaves behind, because what is under test is the hook rather than the fixture that produces the
 * text.
 */
describe('what a review teaches (M49 R2)', () => {
  const repos: string[] = []

  interface ReviewFixture {
    readonly workspaceId: string
    readonly taskId: string
    readonly workerId: string
    readonly reviewerId: string
    readonly reviewRunId: string
  }

  async function seedReviewRun(options: {
    readonly verdict: 'approve' | 'reject'
    readonly reason: string
  }): Promise<ReviewFixture> {
    const repoPath = makeRepo()
    repos.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const worker = await prisma.slave.create({
      data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    const reviewer = await prisma.slave.create({
      data: { teamId: team.id, name: 'Riley', role: 'Senior Engineer', runtimeRoles: ['reviewer'] },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Add the thing',
        description: 'make it work',
        status: 'reviewing',
        requiredRole: 'backend',
        maxAttempts: workspace.maxAttempts,
        branch: 'slaveofai/TASK-049-x',
      },
    })
    // The run that did the work, and then the run that judged it -- in that order, because
    // `implementerOf` reads the task's NEWEST implementation run and both rows exist by the time
    // the conclusion runs.
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: worker.id,
        kind: 'implementation',
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    const reviewRun = await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: reviewer.id,
        kind: 'review',
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.task.update({ where: { id: task.id }, data: { activeRunId: reviewRun.id } })
    await appendEvent({
      type: 'run.output',
      workspaceId: workspace.id,
      taskId: task.id,
      slaveId: reviewer.id,
      runId: reviewRun.id,
      actor: 'slave',
      payload: { text: JSON.stringify({ verdict: options.verdict, reason: options.reason }) },
    })
    return {
      workspaceId: workspace.id,
      taskId: task.id,
      workerId: worker.id,
      reviewerId: reviewer.id,
      reviewRunId: reviewRun.id,
    }
  }

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  it('a rejected review teaches the worker that DID the work, never the reviewer', async (): Promise<void> => {
    const fixture = await seedReviewRun({
      verdict: 'reject',
      reason: 'The diff does not handle the empty-input case the task requires.',
    })

    await concludeReview(brandRunId(fixture.reviewRunId))

    const lessons = await prisma.memory.findMany({ where: { taskId: fixture.taskId, type: 'lesson' } })
    expect(lessons).toHaveLength(1)
    expect(lessons[0]?.scope).toBe('worker')
    expect(lessons[0]?.slaveId).toBe(fixture.workerId)
    expect(lessons[0]?.slaveId).not.toBe(fixture.reviewerId)
    expect(lessons[0]?.verifiedBy).toBe('review')
    expect(lessons[0]?.sourceKind).toBe('review')
    expect(lessons[0]?.body).toBe('The diff does not handle the empty-input case the task requires.')
    expect(lessons[0]?.sourceRef).toBe(fixture.reviewRunId)
    // The row belongs to the worker; the event still reaches the project's own stream.
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId, type: 'memory_recorded' } }),
    ).toBe(1)
  })

  it('an approved review teaches nobody anything', async (): Promise<void> => {
    const fixture = await seedReviewRun({ verdict: 'approve', reason: 'looks right' })

    await concludeReview(brandRunId(fixture.reviewRunId))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('merging')
    expect(await prisma.memory.count({ where: { taskId: fixture.taskId } })).toBe(0)
  })

  // The reject branch that never reaches `rejectTask`: a verdict for a task somebody else has
  // moved on is ignored, and an ignored verdict teaches nothing either.
  it('teaches nothing when the verdict is ignored', async (): Promise<void> => {
    const fixture = await seedReviewRun({ verdict: 'reject', reason: 'not yet' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'cancelled' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await concludeReview(brandRunId(fixture.reviewRunId))
    } finally {
      warn.mockRestore()
    }

    expect(await prisma.memory.count({ where: { taskId: fixture.taskId } })).toBe(0)
  })
})
