/**
 * Conductor Plan 4a, Task 5: the goal pass. A goal version whose packages are all on its
 * integration branch is accepted, and merged into the base branch once -- automatically only when
 * `autoMerge` allows it AND the base branch has not moved since the version was cut (controller
 * ruling P9: nothing reaches the base branch unverified, so the one automatic merge is the
 * fast-forward whose tree is exactly the integrated one). Real git in a temp repository; task
 * states are driven directly with Prisma.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmGoalMerge, recordRunEvidence } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { integrationBranchName, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptGoal, runGoalPass } from '../../src/goal.js'
import { ensureIntegrationBranch, ensureIntegrationWorktree, integrationWorktreePath } from '../../src/goalBranch.js'
import { worktreeRootFor } from '../../src/worktree.js'

/** Fix round 1, M1: runs inside the merge, after its checks and before git moves anything -- a
 *  test moves the integration branch here to race the fast-forward. */
const beforeMerge = vi.hoisted(() => ({ hook: null as (() => void) | null }))
vi.mock('../../src/gitMerge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gitMerge.js')>()
  return {
    ...original,
    primaryCheckoutReady: async (repoPath: string, baseBranch: string): Promise<boolean> => {
      const ready = await original.primaryCheckoutReady(repoPath, baseBranch)
      beforeMerge.hook?.()
      return ready
    },
  }
})

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-goal-pass-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, 'a.txt'), 'original\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

function commitIn(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content)
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', message], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

interface Fixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly deliveryId: string
  readonly branch: string
  readonly integrationPath: string
  readonly taskIds: readonly [string, string]
  readonly runIds: readonly [string, string]
}

/**
 * A conducted workspace at goal v1: its integration branch and delivery row as the conductor
 * leaves them, the integration worktree the merge pass keeps, two package tasks with a concluded
 * implementation run each (and its evidence fact), and one package commit on the integration branch.
 */
async function seed(overrides: { readonly autoMerge?: boolean } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Goal Pass',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: 'conducted',
      autoMerge: overrides.autoMerge ?? true,
      goal: 'Add a CSV mode.\nAnd a JSON one.',
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Alex' } })).id },
  })
  const branch = integrationBranchName(1, workspace.id)
  const { baseCommit } = await ensureIntegrationBranch(repoPath, 'main', branch)
  const delivery = await prisma.goalDelivery.create({
    data: { workspaceId: workspace.id, goalVersion: 1, integrationBranch: branch, baseCommit },
  })
  const integrationPath = await ensureIntegrationWorktree(repoPath, { deliveryId: delivery.id, goalVersion: 1, branch }, workspace.id)
  commitIn(integrationPath, 'a.txt', 'the goal changed this\n', 'merge(T-pkg): the package')

  const taskIds: string[] = []
  const runIds: string[] = []
  for (const key of ['csv', 'json']) {
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: 1, key, title: key, requirementKeys: ['R1'], ownedPaths: [`${key}/**`], interface: '', templateId: 'tpl' },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `The ${key} package`,
        description: 'x',
        status: 'reviewing',
        requiredRole: 'backend',
        maxAttempts: 5,
        workPackageId: pkg.id,
        goalVersion: 1,
      },
    })
    const run = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: slave.id, status: 'succeeded', terminalAt: new Date() },
    })
    await recordRunEvidence(run.id)
    taskIds.push(task.id)
    runIds.push(run.id)
  }
  return {
    workspaceId: workspace.id,
    repoPath,
    deliveryId: delivery.id,
    branch,
    integrationPath,
    taskIds: [taskIds[0] ?? '', taskIds[1] ?? ''],
    runIds: [runIds[0] ?? '', runIds[1] ?? ''],
  }
}

/** Marks a package task merged into its integration branch, as the merge pass leaves it. */
async function integrate(taskId: string): Promise<void> {
  await prisma.task.update({ where: { id: taskId }, data: { status: 'done', integratedAt: new Date() } })
}

async function integrateAll(f: Fixture): Promise<void> {
  for (const id of f.taskIds) await integrate(id)
}

/** The pass as the tick runs it, with no room for a new run: these tests are about acceptance's
 *  aftermath and the merge, and a verification run is `verification.test.ts`'s. */
const pass = async (f: Fixture): Promise<void> =>
  runGoalPass(
    {
      workspaceId: brandWorkspaceId(f.workspaceId),
      registry: {
        resolve: () => {
          throw new Error('the goal pass must not start a run in these tests')
        },
      },
    },
    { mayStartRuns: false },
  )

/**
 * Conductor Plan 4b: a version is accepted only by a verification that passed every requirement
 * (spec R9). This is that acceptance without the run's process -- a verification run row holding
 * the claim, then `acceptGoal` with the integration tip as it is now as the verified commit.
 */
async function acceptVerified(f: Fixture): Promise<void> {
  const row = await delivery(f)
  if (row.status !== 'integrating') return
  const seat = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId } } })
  const run = await prisma.slaveRun.create({
    data: { slaveId: seat.id, kind: 'verification', status: 'succeeded', terminalAt: new Date(), goalDeliveryId: f.deliveryId },
  })
  await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeRunId: run.id } })
  expect(await acceptGoal(f.deliveryId, { runId: run.id, verifiedCommit: git(['rev-parse', f.branch], f.repoPath) })).toBe(true)
}

async function goalEvents(workspaceId: string): Promise<readonly { readonly type: string; readonly payload: unknown }[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: { in: ['workspace_goal_accepted', 'workspace_goal_merged'] } },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type, payload: row.payload }))
}

async function mergeTrips(workspaceId: string): Promise<readonly string[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'guardrail_tripped' }, orderBy: { seq: 'asc' } })
  return rows
    .map((row) => row.payload as { guardrail: string; detail: string })
    .filter((payload) => payload.guardrail === 'merge_failure')
    .map((payload) => payload.detail)
}

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
}, 30_000)

const delivery = async (f: Fixture) => prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })

describe('runGoalPass', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('does nothing while a package is still in review', async (): Promise<void> => {
    const f = await seed()
    await integrate(f.taskIds[0])

    await pass(f)

    expect((await delivery(f)).status).toBe('integrating')
    expect(await goalEvents(f.workspaceId)).toEqual([])
  })

  it('accepts a fully integrated version and fast-forwards the unchanged base branch to it, in the same pass', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    const integrationTip = git(['rev-parse', f.branch], f.repoPath)

    await pass(f)

    const row = await delivery(f)
    expect(row.status).toBe('accepted')
    expect(row.acceptedAt).not.toBeNull()
    expect(row.mergedAt).not.toBeNull()
    expect(row.mergeError).toBeNull()
    // P9: a fast-forward -- the base branch IS the integrated tree, nothing new was made on it.
    const mainTip = git(['rev-parse', 'main'], f.repoPath)
    expect(mainTip).toBe(integrationTip)
    expect(git(['show', 'main:a.txt'], f.repoPath)).toBe('the goal changed this')
    expect(await goalEvents(f.workspaceId)).toEqual([
      { type: 'workspace.goal_accepted', payload: { version: 1, rounds: 1 } },
      { type: 'workspace.goal_merged', payload: { version: 1, branch: f.branch, into: 'main', commit: mainTip, by: 'system' } },
    ])
    // The worktree is spent; the branch is the version's record and stays.
    expect(existsSync(f.integrationPath)).toBe(false)
    expect(git(['rev-parse', f.branch], f.repoPath)).toBe(integrationTip)
    // Plan D4: the integration verdict is settled at the final merge, for every package task.
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBe(true)
    }
    expect(await mergeTrips(f.workspaceId)).toEqual([])
  })

  it('accepts but does not merge when autoMerge is off, and a second pass changes nothing', async (): Promise<void> => {
    const f = await seed({ autoMerge: false })
    await integrateAll(f)
    await acceptVerified(f)
    const mainBefore = git(['rev-parse', 'main'], f.repoPath)

    await pass(f)
    await pass(f)

    const row = await delivery(f)
    expect(row.status).toBe('accepted')
    expect(row.mergedAt).toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(mainBefore)
    expect((await goalEvents(f.workspaceId)).map((event) => event.type)).toEqual(['workspace.goal_accepted'])
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBeNull()
    }
  })

  it('waits for a dirty primary checkout, says so once, and merges on the first pass after it is clean', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    const mainBefore = git(['rev-parse', 'main'], f.repoPath)
    const scratch = join(f.repoPath, 'notes.txt')
    writeFileSync(scratch, 'the person is working here\n')

    await pass(f)
    await pass(f)

    expect((await delivery(f)).status).toBe('accepted')
    expect((await delivery(f)).mergedAt).toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(mainBefore)
    const trips = await mergeTrips(f.workspaceId)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toContain('goal v1')
    expect(trips[0]).toContain('clean')

    rmSync(scratch)
    await pass(f)

    expect((await delivery(f)).mergedAt).not.toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', f.branch], f.repoPath))
  })

  it('waits the same way for a primary checkout on another branch', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    const mainBefore = git(['rev-parse', 'main'], f.repoPath)
    git(['checkout', '-q', '-b', 'side'], f.repoPath)

    await pass(f)
    await pass(f)

    expect((await delivery(f)).mergedAt).toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(mainBefore)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repoPath)).toBe('side')
    const trips = await mergeTrips(f.workspaceId)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toContain('goal v1')

    git(['checkout', '-q', 'main'], f.repoPath)
    await pass(f)

    expect((await delivery(f)).mergedAt).not.toBeNull()
  })

  it('does not merge automatically when the base branch moved since the cut: it waits for a person, base untouched', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    // The person commits to `main` after the cut, on the very line the goal changed.
    const moved = commitIn(f.repoPath, 'a.txt', 'the person changed this\n', 'person works on main')

    await pass(f)
    await pass(f)

    const row = await delivery(f)
    expect(row.status).toBe('accepted')
    expect(row.mergedAt).toBeNull()
    // Nothing was tried: this is a wait for a person, not a failed merge.
    expect(row.mergeError).toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(moved)
    expect(git(['rev-parse', 'HEAD'], f.repoPath)).toBe(moved)
    expect(git(['status', '--porcelain'], f.repoPath)).toBe('')
    expect((await goalEvents(f.workspaceId)).map((event) => event.type)).toEqual(['workspace.goal_accepted'])
    const trips = await mergeTrips(f.workspaceId)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toContain('goal v1')
    expect(trips[0]).toContain('moved since')
    expect(trips[0]).toContain('confirm-goal-merge')
    // The worktree stays for the person's hand merge.
    expect(existsSync(f.integrationPath)).toBe(true)
  })

  it('attributes a hand merge after the base-moved wait to the person, and confirm-goal-merge still succeeds', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    commitIn(f.repoPath, 'mine.txt', 'the person works here\n', 'person works on main')
    await pass(f)
    // The person does what the trip told them: merge by hand, then (later) confirm.
    git(['merge', '-q', '--no-ff', '--no-edit', f.branch], f.repoPath)
    const tip = git(['rev-parse', 'main'], f.repoPath)

    await pass(f)

    const merged = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_merged' } })
    expect(merged).toHaveLength(1)
    expect(merged[0]?.actor).toBe('human')
    expect(merged[0]?.payload).toEqual({ version: 1, branch: f.branch, into: 'main', commit: tip, by: 'human' })
    expect((await delivery(f)).mergedAt).not.toBeNull()

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: tip } })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_merged' } })).toBe(1)
  })

  it('announces a confirmed hand merge once, as the person\'s, when the pass runs after the confirm', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    commitIn(f.repoPath, 'mine.txt', 'the person works here\n', 'person works on main')
    await pass(f)
    git(['merge', '-q', '--no-ff', '--no-edit', f.branch], f.repoPath)
    const tip = git(['rev-parse', 'main'], f.repoPath)

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: tip } })
    await pass(f)

    const merged = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_merged' } })
    expect(merged.map((event) => (event.payload as { by: string }).by)).toEqual(['human'])
    expect(existsSync(f.integrationPath)).toBe(false)
  })

  it('says once that an accepted version waits for a hand merge when autoMerge is off', async (): Promise<void> => {
    const f = await seed({ autoMerge: false })
    await integrateAll(f)
    await acceptVerified(f)

    await pass(f)
    await pass(f)

    const trips = await mergeTrips(f.workspaceId)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toContain('goal v1 is accepted and autoMerge is off')
    expect(trips[0]).toContain(`confirm-goal-merge --workspace ${f.workspaceId} --version 1`)
    expect((await delivery(f)).mergedAt).toBeNull()
  })

  it('goes on to the open versions when a merged version\'s integration branch is gone', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    // A stamped, unannounced row whose branch somebody deleted: the recovery cannot name its commit.
    await prisma.goalDelivery.create({
      data: {
        workspaceId: f.workspaceId,
        goalVersion: 7,
        integrationBranch: 'slaveofai/goal-gone',
        baseCommit: 'abc',
        status: 'accepted',
        acceptedAt: new Date(),
        mergedAt: new Date(),
      },
    })

    await pass(f)

    expect((await delivery(f)).mergedAt).not.toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', f.branch], f.repoPath))
  })

  // Final wave M4: an accepted version whose integration branch was deleted cannot be merged or
  // waited on; the pass says so once, with the person's two ways out, instead of throwing each tick.
  for (const autoMerge of [true, false]) {
    it(`says once that an accepted version's integration branch is gone (autoMerge ${String(autoMerge)})`, async (): Promise<void> => {
      const f = await seed({ autoMerge })
      await integrateAll(f)
      await acceptVerified(f)
      git(['worktree', 'remove', '--force', f.integrationPath], f.repoPath)
      git(['branch', '-D', f.branch], f.repoPath)

      await pass(f)
      await pass(f)

      expect(await mergeTrips(f.workspaceId)).toEqual([
        `the integration branch ${f.branch} of goal v1 is gone: restore it or run abandon-goal --workspace ${f.workspaceId} --version 1`,
      ])
      expect(await delivery(f)).toMatchObject({ status: 'accepted', mergedAt: null, mergeError: null })
    })
  }

  it('records a merge git refuses, leaves the checkout clean, and never retries it by itself', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    // The integration branch no longer descends from the cut (somebody rewrote it, and that tip is
    // what was verified): the base branch has not moved, so the pass tries, and git refuses the
    // fast-forward.
    git(['checkout', '-q', '--orphan', 'rewritten'], f.integrationPath)
    git(['rm', '-rfq', '.'], f.integrationPath)
    commitIn(f.integrationPath, 'other.txt', 'unrelated\n', 'unrelated history')
    git(['branch', '-f', f.branch, 'rewritten'], f.repoPath)
    await acceptVerified(f)
    const mainBefore = git(['rev-parse', 'main'], f.repoPath)

    await pass(f)

    const row = await delivery(f)
    expect(row.status).toBe('accepted')
    expect(row.mergedAt).toBeNull()
    expect(row.mergeError).not.toBeNull()
    expect(git(['status', '--porcelain'], f.repoPath)).toBe('')
    expect(git(['rev-parse', 'HEAD'], f.repoPath)).toBe(mainBefore)
    expect(await mergeTrips(f.workspaceId)).toHaveLength(1)

    await pass(f)

    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(mainBefore)
    expect(await mergeTrips(f.workspaceId)).toHaveLength(1)
    expect((await delivery(f)).mergedAt).toBeNull()
  })

  it('never accepts a version while one of its packages is blocked', async (): Promise<void> => {
    const f = await seed()
    await integrate(f.taskIds[0])
    await prisma.task.update({ where: { id: f.taskIds[1] }, data: { status: 'blocked' } })

    await pass(f)
    await pass(f)

    expect((await delivery(f)).status).toBe('integrating')
    expect(await goalEvents(f.workspaceId)).toEqual([])
  })

  it('finishes a merge a crash interrupted after the fast-forward: stamped and announced, no false "base moved" trip', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    // The fast-forward happened; the daemon died before `mergedAt` was written.
    git(['merge', '-q', '--ff-only', f.branch], f.repoPath)
    const mainTip = git(['rev-parse', 'main'], f.repoPath)

    await pass(f)
    await pass(f)

    const row = await delivery(f)
    expect(row.mergedAt).not.toBeNull()
    expect(row.mergeError).toBeNull()
    expect(await goalEvents(f.workspaceId)).toEqual([
      { type: 'workspace.goal_accepted', payload: { version: 1, rounds: 1 } },
      { type: 'workspace.goal_merged', payload: { version: 1, branch: f.branch, into: 'main', commit: mainTip, by: 'system' } },
    ])
    expect(await mergeTrips(f.workspaceId)).toEqual([])
    expect(existsSync(f.integrationPath)).toBe(false)
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBe(true)
    }
  })

  it('announces and settles a merge whose stamp landed but whose event a crash lost, exactly once', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    git(['merge', '-q', '--ff-only', f.branch], f.repoPath)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'accepted', acceptedAt: new Date(), mergedAt: new Date() } })

    await pass(f)
    await pass(f)

    const merged = (await goalEvents(f.workspaceId)).filter((event) => event.type === 'workspace.goal_merged')
    expect(merged).toEqual([
      {
        type: 'workspace.goal_merged',
        payload: { version: 1, branch: f.branch, into: 'main', commit: git(['rev-parse', f.branch], f.repoPath), by: 'system' },
      },
    ])
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBe(true)
    }
  })

  it('merges once and announces once when two passes overlap on an accepted version', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)

    await Promise.all([pass(f), pass(f)])

    const row = await delivery(f)
    expect(row.mergedAt).not.toBeNull()
    expect(row.mergeError).toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', f.branch], f.repoPath))
    expect((await goalEvents(f.workspaceId)).map((event) => event.type)).toEqual(['workspace.goal_accepted', 'workspace.goal_merged'])
    expect(await mergeTrips(f.workspaceId)).toEqual([])
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBe(true)
    }
  })

  it('announces a stamped-but-unannounced merge once when two passes overlap on it', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    git(['merge', '-q', '--ff-only', f.branch], f.repoPath)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'accepted', acceptedAt: new Date(), mergedAt: new Date() } })

    await Promise.all([pass(f), pass(f)])

    expect((await goalEvents(f.workspaceId)).map((event) => event.type)).toEqual(['workspace.goal_merged'])
    for (const runId of f.runIds) {
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).integrated).toBe(true)
    }
  })

  it('never accepts a fully integrated version by itself: acceptance is a passing verification\'s (Plan 4b)', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)

    await Promise.all([pass(f), pass(f)])

    expect(await delivery(f)).toMatchObject({ status: 'integrating', acceptedAt: null, mergedAt: null })
    expect(await goalEvents(f.workspaceId)).toEqual([])
    expect(git(['rev-parse', 'main'], f.repoPath)).not.toBe(git(['rev-parse', f.branch], f.repoPath))
  })

  it('does not merge a tip nothing verified: an integration branch that moved after acceptance is verified again', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    const mainBefore = git(['rev-parse', 'main'], f.repoPath)
    commitIn(f.integrationPath, 'late.txt', 'late\n', 'a change after the verification')

    await pass(f)

    // Fix round 1, M2 (ruling V5): back to integrating with a fresh round window, said once as a
    // retry -- never a hand merge of a tree nobody verified.
    expect(await delivery(f)).toMatchObject({ status: 'integrating', acceptedAt: null, mergedAt: null, verifiedCommit: null, roundBase: 1, roundRunFailures: 0 })
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(mainBefore)
    const retried = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_retried' } })
    expect(retried.map((event) => [event.actor, event.payload])).toEqual([['system', { version: 1, round: 1, cause: 'branch_moved' }]])
    expect((await mergeTrips(f.workspaceId)).join('\n')).not.toContain('by hand')

    await pass(f)
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_retried' } })).toBe(1)
  })

  it('verifies again an accepted version whose branch moved even with autoMerge off', async (): Promise<void> => {
    const f = await seed({ autoMerge: false })
    await integrateAll(f)
    await acceptVerified(f)
    commitIn(f.integrationPath, 'late.txt', 'late\n', 'a change after the verification')

    await pass(f)

    expect((await delivery(f)).status).toBe('integrating')
    expect(await mergeTrips(f.workspaceId)).toEqual([])
  })

  it('fast-forwards to the verified commit, never to a tip the branch moved to during the merge', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await acceptVerified(f)
    const verified = git(['rev-parse', f.branch], f.repoPath)
    beforeMerge.hook = (): void => {
      beforeMerge.hook = null
      commitIn(f.integrationPath, 'raced.txt', 'raced\n', 'a change racing the merge')
    }
    try {
      await pass(f)
    } finally {
      beforeMerge.hook = null
    }

    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(verified)
    expect(git(['rev-parse', f.branch], f.repoPath)).not.toBe(verified)
  })

  it('removes the integration worktree a confirmed hand merge left behind, and keeps the branch', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'accepted', acceptedAt: new Date(), mergedAt: new Date() } })
    const tip = git(['rev-parse', f.branch], f.repoPath)
    expect(existsSync(integrationWorktreePath(f.repoPath, 1, f.workspaceId))).toBe(true)

    await pass(f)

    expect(existsSync(integrationWorktreePath(f.repoPath, 1, f.workspaceId))).toBe(false)
    expect(git(['rev-parse', f.branch], f.repoPath)).toBe(tip)
    // No `goal_merged` existed for the stamp, so the pass writes the one it recovers (fix round 1).
    expect((await goalEvents(f.workspaceId)).map((event) => event.type)).toEqual(['workspace.goal_merged'])
  })
})

describe('acceptGoal', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  /** The delivery in round 1 with a verification run holding its claim; returns the verdict. */
  async function verifying(f: Fixture): Promise<{ readonly runId: string; readonly verifiedCommit: string }> {
    const seat = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId } } })
    const run = await prisma.slaveRun.create({
      data: { slaveId: seat.id, kind: 'verification', status: 'succeeded', terminalAt: new Date(), goalDeliveryId: f.deliveryId },
    })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeRunId: run.id } })
    return { runId: run.id, verifiedCommit: git(['rev-parse', f.branch], f.repoPath) }
  }

  it('applies once when two calls overlap: one goal_accepted, the claim released, the verified commit recorded', async (): Promise<void> => {
    const f = await seed()
    const verdict = await verifying(f)

    const results = await Promise.all([acceptGoal(f.deliveryId, verdict), acceptGoal(f.deliveryId, verdict)])

    expect(results.toSorted()).toEqual([false, true])
    expect(await goalEvents(f.workspaceId)).toEqual([{ type: 'workspace.goal_accepted', payload: { version: 1, rounds: 1 } }])
    expect(await delivery(f)).toMatchObject({ status: 'accepted', activeRunId: null, verifiedCommit: verdict.verifiedCommit })
  })

  it('stamps an acceptance whose event a crash already wrote, without a second event', async (): Promise<void> => {
    const f = await seed()
    const verdict = await verifying(f)
    // The event landed; the daemon died before the status moved.
    await appendEvent({ type: 'workspace.goal_accepted', workspaceId: f.workspaceId, actor: 'system', payload: { version: 1, rounds: 1 } })

    expect(await acceptGoal(f.deliveryId, verdict)).toBe(true)

    expect((await delivery(f)).status).toBe('accepted')
    expect(await goalEvents(f.workspaceId)).toHaveLength(1)
  })

  it('applies once on a replay: one goal_accepted', async (): Promise<void> => {
    const f = await seed()
    const verdict = await verifying(f)

    expect(await acceptGoal(f.deliveryId, verdict)).toBe(true)
    expect(await acceptGoal(f.deliveryId, verdict)).toBe(false)

    expect(await goalEvents(f.workspaceId)).toEqual([{ type: 'workspace.goal_accepted', payload: { version: 1, rounds: 1 } }])
    expect((await delivery(f)).status).toBe('accepted')
  })

  it('expires the version\'s undelivered hand-offs in the acceptance itself (plan A D4, ruling F3)', async (): Promise<void> => {
    const f = await seed()
    const verdict = await verifying(f)
    const handOff = { workspaceId: f.workspaceId, goalVersion: 1, source: 'report' as const, fromRunId: f.runIds[0], fromPackageKey: 'csv', toPackageKey: 'json', packageKey: 'json', change: 'x', fingerprint: 'f' }
    await prisma.packageHandOff.createMany({
      data: [
        { ...handOff, sourceKey: 'report:a:0', status: 'pending' },
        { ...handOff, sourceKey: 'report:a:1', status: 'reopened' },
      ],
    })

    expect(await acceptGoal(f.deliveryId, verdict)).toBe(true)

    const rows = await prisma.packageHandOff.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { sourceKey: 'asc' } })
    expect(rows.map((row) => [row.status, row.note])).toEqual([
      ['expired', 'the version was accepted before it could be delivered'],
      ['reopened', null],
    ])
  })

  it('never accepts an integrating version, nor for a run that does not hold the claim', async (): Promise<void> => {
    const f = await seed()
    const tip = git(['rev-parse', f.branch], f.repoPath)

    expect(await acceptGoal(f.deliveryId, { runId: 'nobody', verifiedCommit: tip })).toBe(false)
    await verifying(f)
    expect(await acceptGoal(f.deliveryId, { runId: 'another-run', verifiedCommit: tip })).toBe(false)

    expect((await delivery(f)).status).toBe('verifying')
    expect(await goalEvents(f.workspaceId)).toEqual([])
  })
})
