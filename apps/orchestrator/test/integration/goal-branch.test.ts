import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, integrationBranchName, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseRefFor, ensureIntegrationBranch, integrationTargetFor } from '../../src/goalBranch.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** `conductor-e2e.test.ts`'s repository, cut to one commit on `main`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-goal-branch-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
}, 30_000)

const BRANCH = 'slaveofai/goal-v1-abcdef12'

describe('ensureIntegrationBranch', () => {
  it("cuts the branch at the base branch's tip and returns that commit", async () => {
    const repo = makeRepo()
    const tip = git(['rev-parse', 'main'], repo)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual({ baseCommit: tip })
    expect(git(['rev-parse', BRANCH], repo)).toBe(tip)
  })

  it('reuses its own branch on a replay (the daemon died before the delivery row committed)', async () => {
    const repo = makeRepo()
    const first = await ensureIntegrationBranch(repo, 'main', BRANCH)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual(first)
  })

  it('reuses a branch the base branch has since moved past', async () => {
    const repo = makeRepo()
    const first = await ensureIntegrationBranch(repo, 'main', BRANCH)
    writeFileSync(join(repo, 'more.txt'), 'more\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'more'], repo)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual(first)
  })

  it("refuses a branch of that name that carries a commit not on the base branch's history", async () => {
    const repo = makeRepo()
    git(['checkout', '-q', '-b', BRANCH], repo)
    writeFileSync(join(repo, 'foreign.txt'), 'foreign\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'foreign'], repo)
    git(['checkout', '-q', 'main'], repo)
    await expect(ensureIntegrationBranch(repo, 'main', BRANCH)).rejects.toThrow(/is not on main's history/)
  })
})

/** Commits `file` onto `branch` without touching the primary checkout -- a scratch worktree, the
 *  way a merged dependency package's work reaches the integration branch. */
function commitOnto(repo: string, branch: string, file: string, content: string): void {
  const dir = join(mkdtempSync(join(tmpdir(), 'slaveofai-goal-branch-scratch-')), 'tree')
  git(['worktree', 'add', '-q', dir, branch], repo)
  writeFileSync(join(dir, file), content)
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', `add ${file}`], dir)
  git(['worktree', 'remove', '--force', dir], repo)
}

interface Seeded {
  readonly workspaceId: string
  readonly repoPath: string
  readonly teamId: string
}

/** A conducted workspace at goal version 1, as `run-report.test.ts` seeds it: packages already
 *  materialised, so the conductor's turn in the tick is `none`. */
async function seedConducted(): Promise<Seeded> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Goal Branch',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: 'conducted',
      goal: 'Add a report',
      goalVersion: 1,
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.requirementSet.create({
    data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'a report', source: 'add a report' }] },
  })
  return { workspaceId: workspace.id, repoPath, teamId: team.id }
}

/** A `ready` package task pinned to its own seat. */
async function seedPackageTask(s: Seeded, goalVersion = 1): Promise<string> {
  const pkg = await prisma.workPackage.create({
    data: {
      workspaceId: s.workspaceId,
      goalVersion,
      key: 'main',
      title: 'main',
      requirementKeys: ['R1'],
      ownedPaths: ['**'],
      interface: '',
      isIntegration: true,
      templateId: 'tpl',
    },
  })
  const seat = await prisma.slave.create({
    data: { teamId: s.teamId, role: 'Implementer', runtimeRoles: [PACKAGE_WORKER_ROLE], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: s.workspaceId,
      title: 'main',
      description: 'the main package',
      status: 'ready',
      requiredRole: PACKAGE_WORKER_ROLE,
      requiredCapabilities: [],
      createdBy: 'system',
      maxAttempts: 3,
      goalVersion,
      assigneeId: seat.id,
      workPackageId: pkg.id,
    },
  })
  return task.id
}

/** The delivery row Task 2's `materialise` writes, with its branch cut from `main`. */
async function seedDelivery(s: Seeded, goalVersion = 1): Promise<{ readonly id: string; readonly branch: string }> {
  const branch = integrationBranchName(goalVersion, s.workspaceId)
  const { baseCommit } = await ensureIntegrationBranch(s.repoPath, 'main', branch)
  const row = await prisma.goalDelivery.create({ data: { workspaceId: s.workspaceId, goalVersion, integrationBranch: branch, baseCommit } })
  return { id: row.id, branch }
}

function depsWithReport(workspaceId: string): TickDeps {
  const report = {
    requirements: [{ key: 'R1', status: 'done', evidence: 'the fake wrote it' }],
    filesTouched: ['m8a-work.txt'],
    workflow: [{ step: 1, done: true, note: '' }],
    questions: [],
  }
  const extraArgs = [FAKE, '--fixture', 'm8-flow', '--report-json-base64', Buffer.from(JSON.stringify(report)).toString('base64')]
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs, hookPath: REAL_GATE })
  return { workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } }
}

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "Artifact", "Checkpoint", "SlaveMessage", "RunReport", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

describe('integrationTargetFor', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it("answers a package task of a delivered version with its version's integration branch", async (): Promise<void> => {
    const s = await seedConducted()
    const delivery = await seedDelivery(s)
    const task = await seedPackageTask(s)
    expect(await integrationTargetFor(task)).toEqual({
      deliveryId: delivery.id,
      goalVersion: 1,
      branch: integrationBranchName(1, s.workspaceId),
    })
    expect(await baseRefFor(task, 'main')).toBe(integrationBranchName(1, s.workspaceId))
  })

  it('answers null for a package of a version conducted before goal deliveries existed (plan D5)', async (): Promise<void> => {
    const s = await seedConducted()
    const task = await seedPackageTask(s)
    expect(await integrationTargetFor(task)).toBeNull()
    expect(await baseRefFor(task, 'main')).toBe('main')
  })

  it('answers null for a task with no package, even in a workspace with a delivery', async (): Promise<void> => {
    const s = await seedConducted()
    await seedDelivery(s)
    const plain = await prisma.task.create({
      data: { workspaceId: s.workspaceId, title: 'plain', description: 'no package', status: 'ready', requiredRole: 'backend', maxAttempts: 3 },
    })
    expect(await integrationTargetFor(plain.id)).toBeNull()
    expect(await baseRefFor(plain.id, 'main')).toBe('main')
  })
})

describe('a package task is cut from its integration branch', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it("provisions the run's worktree from the integration branch, carrying its dependency's commit", async (): Promise<void> => {
    const s = await seedConducted()
    const delivery = await seedDelivery(s)
    // A dependency package already merged into the integration branch; `main` never saw it.
    commitOnto(s.repoPath, delivery.branch, 'dep.txt', 'the dependency\n')
    const task = await seedPackageTask(s)

    await tick(depsWithReport(s.workspaceId))
    await drainPumps()

    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: task, kind: 'implementation' } })
    expect(run.worktreePath).not.toBeNull()
    expect(existsSync(join(run.worktreePath ?? '', 'dep.txt'))).toBe(true)
    expect(existsSync(join(s.repoPath, 'dep.txt'))).toBe(false)
  }, 60_000)

  it('keeps cutting a package of a version with no delivery from the base branch (plan D5)', async (): Promise<void> => {
    const s = await seedConducted()
    // A branch of the would-be name carrying dep.txt, but no delivery row: it must not be used.
    const branch = integrationBranchName(1, s.workspaceId)
    git(['branch', branch, 'main'], s.repoPath)
    commitOnto(s.repoPath, branch, 'dep.txt', 'the dependency\n')
    const task = await seedPackageTask(s)

    await tick(depsWithReport(s.workspaceId))
    await drainPumps()

    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: task, kind: 'implementation' } })
    expect(run.worktreePath).not.toBeNull()
    expect(existsSync(join(run.worktreePath ?? '', 'dep.txt'))).toBe(false)
  }, 60_000)
})
