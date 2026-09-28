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
import { recordRunEvidence } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { integrationBranchName, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { acceptGoal, runGoalPass } from '../../src/goal.js'
import { ensureIntegrationBranch, ensureIntegrationWorktree, integrationWorktreePath } from '../../src/goalBranch.js'
import { worktreeRootFor } from '../../src/worktree.js'

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

const pass = async (f: Fixture): Promise<void> => runGoalPass(brandWorkspaceId(f.workspaceId))

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
      { type: 'workspace.goal_accepted', payload: { version: 1, rounds: 0 } },
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

  it('records a merge git refuses, leaves the checkout clean, and never retries it by itself', async (): Promise<void> => {
    const f = await seed()
    await integrateAll(f)
    // The integration branch no longer descends from the cut (somebody rewrote it): the base branch
    // has not moved, so the pass tries, and git refuses the fast-forward.
    git(['checkout', '-q', '--orphan', 'rewritten'], f.integrationPath)
    git(['rm', '-rfq', '.'], f.integrationPath)
    commitIn(f.integrationPath, 'other.txt', 'unrelated\n', 'unrelated history')
    git(['branch', '-f', f.branch, 'rewritten'], f.repoPath)
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
    await acceptGoal(f.deliveryId, 0)
    // The fast-forward happened; the daemon died before `mergedAt` was written.
    git(['merge', '-q', '--ff-only', f.branch], f.repoPath)
    const mainTip = git(['rev-parse', 'main'], f.repoPath)

    await pass(f)
    await pass(f)

    const row = await delivery(f)
    expect(row.mergedAt).not.toBeNull()
    expect(row.mergeError).toBeNull()
    expect(await goalEvents(f.workspaceId)).toEqual([
      { type: 'workspace.goal_accepted', payload: { version: 1, rounds: 0 } },
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

  it('applies once on a replay: one goal_accepted', async (): Promise<void> => {
    const f = await seed()

    expect(await acceptGoal(f.deliveryId, 0)).toBe(true)
    expect(await acceptGoal(f.deliveryId, 0)).toBe(false)

    expect(await goalEvents(f.workspaceId)).toEqual([{ type: 'workspace.goal_accepted', payload: { version: 1, rounds: 0 } }])
    expect((await delivery(f)).status).toBe('accepted')
  })
})
