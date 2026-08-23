import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter } from '@ai-team-os/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildReviewPrompt, concludeReview, dispatchReviews } from '../../src/review.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, because `dispatchReviews` runs real `git diff` against it. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-review-'))
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
  readonly agentId: string
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
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend' },
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
  return { workspaceId: workspace.id, taskId: task.id, agentId: agent.id, repoPath }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

/**
 * Drives a real `tick` with the `complete` fixture to give the seeded task a real worktree, branch
 * and a `succeeded` implementation run -- then parks it in `reviewing` by hand, the way a real merge
 * of Task 8's `advance` extension eventually would. Cheaper and more real than hand-provisioning a
 * worktree and forging an `AgentRun` row: this is the exact shape `dispatchReviews` will actually
 * see in production.
 */
async function seedReviewingTask(fixture: Fixture, reviewFixture = 'review-approve'): Promise<TickDeps> {
  const implDeps: TickDeps = {
    workspaceId: brandWorkspaceId(fixture.workspaceId),
    adapter: new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] }),
    hookPath: REAL_GATE,
  }
  const report = await tick(implDeps)
  expect(report.started).toHaveLength(1)
  await drainPumps()

  const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
  expect(task.status).toBe('done') // sanity: the seeding tick actually landed a real branch + worktree
  await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })

  return {
    workspaceId: brandWorkspaceId(fixture.workspaceId),
    adapter: new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', reviewFixture] }),
    hookPath: REAL_GATE,
  }
}

/** Adds a `reviewer`-role agent to the fixture's one team, idle and ready to be picked up. */
async function addReviewer(): Promise<void> {
  const team = await prisma.team.findFirstOrThrow()
  await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })
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
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toHaveLength(1)
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.kind).toBe('review')
    expect(run.taskId).toBe(fixture.taskId)

    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.review_started')

    await drainPumps()
    const events = await prisma.executionEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } })
    expect(events.map((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type])).toContain('run.output')
  })

  it('starts nothing a second time while the review run it started is still live', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })

    const first = await dispatchReviews(reviewDeps)
    expect(first).toHaveLength(1)

    const second = await dispatchReviews(reviewDeps)

    expect(second).toEqual([])
    expect(await prisma.agentRun.count({ where: { kind: 'review' } })).toBe(1)
  })

  it('escalates once with no reviewer-role agent in the workspace, and starts nothing', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    // No reviewer-role agent exists -- only the `backend` agent `seed()` created.

    const first = await dispatchReviews(reviewDeps)
    expect(first).toEqual([])

    const second = await dispatchReviews(reviewDeps)
    expect(second).toEqual([])

    expect(await prisma.agentRun.count({ where: { kind: 'review' } })).toBe(0)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noReviewerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_reviewer',
    )
    expect(noReviewerEvents).toHaveLength(1)
  })

  it('starts nothing once two review runs newer than the implementation run have failed', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })
    const reviewer = await prisma.agent.findFirstOrThrow({ where: { role: 'reviewer' } })

    const latestImpl = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'implementation' } })
    const after = (offsetMs: number): Date => new Date(latestImpl.startedAt.getTime() + offsetMs)
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: reviewer.id,
        kind: 'review',
        status: 'failed',
        startedAt: after(1_000),
        terminalAt: after(2_000),
        endedAt: after(2_000),
      },
    })
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: reviewer.id,
        kind: 'review',
        status: 'failed',
        startedAt: after(3_000),
        terminalAt: after(4_000),
        endedAt: after(4_000),
      },
    })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    expect(await prisma.agentRun.count({ where: { kind: 'review' } })).toBe(2)
  })

  it('concludes the run failed instead of throwing when the diff itself cannot be produced', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture)
    const team = await prisma.team.findFirstOrThrow()
    await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })
    // A branch recorded on the task but gone from git itself -- the step-2 null check cannot catch
    // it, so the dispatch reaches `git diff` and the diff fails.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { branch: 'no-such-branch' } })

    const started = await dispatchReviews(reviewDeps)

    expect(started).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(run.status).toBe('failed')
    expect(run.terminalAt).not.toBeNull()
    const failures = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
  })

  it('approves: moves the task to merging and records the reason', async (): Promise<void> => {
    const reviewDeps = await seedReviewingTask(fixture, 'review-approve')
    await addReviewer()

    const started = await dispatchReviews(reviewDeps)
    expect(started).toHaveLength(1)
    await drainPumps()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('merging')

    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'review' } })
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
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'review' } })
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

    const firstRun = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'review' } })
    expect(firstRun.status).toBe('failed')
    const afterFirst = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(afterFirst.status).toBe('reviewing')

    const firstFailure = await prisma.executionEvent.findMany({ where: { runId: firstRun.id, type: 'run_failed' } })
    expect(firstFailure).toHaveLength(1)
    expect((firstFailure[0]?.payload as { reason: string }).reason).toContain('no valid verdict')

    // Second dispatch+conclusion with the same invalid fixture: reaches the cap (Task 5), still reviewing.
    const second = await dispatchReviews(reviewDeps)
    expect(second).toHaveLength(1)
    await drainPumps()

    const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(afterSecond.status).toBe('reviewing')
    expect(await prisma.agentRun.count({ where: { kind: 'review' } })).toBe(2)
    expect(await prisma.agentRun.count({ where: { kind: 'review', status: 'failed' } })).toBe(2)

    // No third dispatch: the retry cap bounds it.
    const third = await dispatchReviews(reviewDeps)
    expect(third).toEqual([])
    expect(await prisma.agentRun.count({ where: { kind: 'review' } })).toBe(2)
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
      adapter: new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'review-approve'] }),
      hookPath: REAL_GATE,
    }
    const second = await dispatchReviews(approveDeps)
    expect(second).toHaveLength(1)
    await drainPumps()

    const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(finalTask.status).toBe('merging')
  })
})

describe('buildReviewPrompt', () => {
  it('contains the verdict marker and the diff body', () => {
    const prompt = buildReviewPrompt(
      { title: 'Add the thing', description: 'make it work' },
      'diff --git a/x b/x\n+hello\n',
    )

    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('diff --git a/x b/x')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('Add the thing')
  })
})
