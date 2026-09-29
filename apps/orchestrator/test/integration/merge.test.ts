import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { integrationBranchName, workspaceId as brandWorkspaceId, taskId as brandTaskId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { addRunbook, adoptRunbook, confirmIntegration, recordRunEvidence, settleTaskEvidence } from '@slave-of-ai/control'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureIntegrationBranch, ensureIntegrationWorktree, integrationWorktreePath, type IntegrationTarget } from '../../src/goalBranch.js'
import { runMergePass } from '../../src/merge.js'
import { loadWorld } from '../../src/world.js'
import { provisionWorktree } from '../../src/worktree.js'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, because the merge pass runs real `git rebase`/`git merge` against it. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-merge-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Workspace {
  readonly id: string
  readonly repoPath: string
  readonly slaveId: string
}

const repos: string[] = []

async function seedWorkspace(
  overrides: { readonly autoMerge?: boolean; readonly verifyCommands?: readonly string[] } = {},
): Promise<Workspace> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: [...(overrides.verifyCommands ?? ['true'])],
      setupCommands: [],
      autoMerge: overrides.autoMerge ?? false,
      maxAttempts: 5,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Alex' } })).id } })
  return { id: workspace.id, repoPath, slaveId: slave.id }
}

interface MergingTask {
  readonly taskId: string
  readonly branch: string
  readonly taskKey: string
}

/**
 * Builds one `merging` task by hand, exactly as `dispatchReviews`/`advance`/`concludeReview` would
 * have left it in production: a real worktree on its own branch with a commit, a `succeeded`
 * implementation run pointing at that worktree, and the `task.review_approved` event
 * `runMergePass`'s FIFO ordering reads.
 */
async function seedMergingTask(
  workspace: Workspace,
  input: {
    readonly title?: string
    readonly fileName?: string
    readonly content?: string
    /** M48 R6, fix round 1: the runbook stage this task belongs to, whose gates the post-rebase
     *  re-verify now runs too. `undefined` is every task planned before that milestone. */
    readonly stage?: string
    /** M53 erratum E24: how many attempts this task has left. `1` is the task whose next failure
     *  is its last, which is the only shape a merge failure may settle `integrated: false` for. */
    readonly maxAttempts?: number
  } = {},
): Promise<MergingTask> {
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: input.title ?? 'Add the thing',
      description: 'make it work',
      status: 'merging',
      requiredRole: 'backend',
      maxAttempts: input.maxAttempts ?? 5,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
    },
  })
  const taskKey = `T-${task.id.slice(0, 8)}`
  const worktree = await provisionWorktree({
    repoPath: workspace.repoPath,
    baseBranch: 'main',
    taskKey,
    slug: 'work',
    setupCommands: [],
  })
  writeFileSync(join(worktree.path, input.fileName ?? 'feature.txt'), input.content ?? 'feature content\n')
  git(['add', '-A'], worktree.path)
  git(['commit', '-q', '-m', 'implement the feature'], worktree.path)

  await prisma.task.update({ where: { id: task.id }, data: { branch: worktree.branch } })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: workspace.slaveId,
      status: 'succeeded',
      terminalAt: new Date(),
      worktreePath: worktree.path,
    },
  })
  await appendEvent({
    type: 'task.review_approved',
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
    actor: 'system',
    payload: { reason: 'looks good' },
  })

  return { taskId: task.id, branch: worktree.branch, taskKey }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

const mergeCommitSubjects = (repoPath: string): readonly string[] =>
  git(['log', '--merges', '--reverse', '--format=%s'], repoPath)
    .split('\n')
    .filter((line) => line.length > 0)

describe('runMergePass', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(`${repo}-slaveofai-worktrees`, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  })

  it('(a) merges a green task when autoMerge is true', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId, taskKey } = await seedMergingTask(workspace)

    // The implementation attempt's own verify artifacts, laid down exactly as `verify.ts`'s
    // `runVerify` would have left them for the task's first (and only, here) attempt: one log
    // per verify command, under `attempt-01` directly beneath the task's artifact dir -- the same
    // layout `verifyConcludedRun` points at. Written by hand rather than by calling `runVerify`
    // itself: this test is about the merge pass's own artifact routing, not re-driving the
    // implementation phase.
    const implArtifactDir = join(workspace.repoPath, '.slaveofai', 'artifacts', taskId)
    const implAttemptDir = join(implArtifactDir, 'attempt-01')
    mkdirSync(implAttemptDir, { recursive: true })
    const implLogPath = join(implAttemptDir, '01-true.log')
    const implLogContent = 'command exit 0: true\n(the implementation attempt wrote this)\n'
    writeFileSync(implLogPath, implLogContent)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.mergeClaimedAt).toBeNull()
    // M35 t2: the real-merge path stamps `integratedAt` -- the commits genuinely reached the base
    // branch, so a dependent is safe to unblock.
    expect(task.integratedAt).not.toBeNull()

    const subjects = mergeCommitSubjects(workspace.repoPath)
    expect(subjects.some((subject) => subject.includes(taskKey))).toBe(true)
    // The merged file exists on `main` in the primary checkout.
    expect(() => git(['cat-file', '-e', 'HEAD:feature.txt'], workspace.repoPath)).not.toThrow()

    // The implementation attempt's artifact survives the merge pass byte-identical: the merge
    // pass's own re-verify must not have clobbered it.
    expect(readFileSync(implLogPath, 'utf8')).toBe(implLogContent)

    // The merge pass's own re-verify artifacts land in a sibling `merge/` namespace, never inside
    // the implementation attempt's `attempt-NN` dirs.
    const mergeLogPath = join(implArtifactDir, 'merge', 'attempt-01', '01-true.log')
    expect(existsSync(mergeLogPath)).toBe(true)
    const mergeArtifacts = await prisma.artifact.findMany({ where: { taskId } })
    expect(mergeArtifacts.length).toBeGreaterThan(0)
    for (const artifact of mergeArtifacts) {
      expect(artifact.path).toContain(join(implArtifactDir, 'merge'))
    }
  })

  it('merges past a repository commit-msg hook that would refuse the merge subject', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId, taskKey } = await seedMergingTask(workspace)
    // The shape commitlint installs through lefthook on `npm ci`: a hook that refuses any subject
    // outside its convention -- here, every subject.
    const hookPath = join(workspace.repoPath, '.git', 'hooks', 'commit-msg')
    writeFileSync(hookPath, '#!/bin/sh\necho "subject refused" >&2\nexit 1\n', { mode: 0o755 })

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.integratedAt).not.toBeNull()
    expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
  })

  it('(b) concludes done without merging when autoMerge is false', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId, branch } = await seedMergingTask(workspace)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.mergeClaimedAt).toBeNull()
    // M35 t2: no real merge happened, so `integratedAt` stays null -- the task is `done` but not
    // yet integrated, exactly the spec Decision 5 shape this path has always left it in.
    expect(task.integratedAt).toBeNull()

    expect(mergeCommitSubjects(workspace.repoPath)).toEqual([])
    // The branch the human still needs is left alone.
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], workspace.repoPath)).toContain(branch)
    expect(await eventTypesFor(workspace.id)).toContain('task.done')
  })

  it('(c) sends a task with a rebase conflict back to rework', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace, { fileName: 'README.md', content: 'task version\n' })
    const mainBefore = git(['rev-parse', 'main'], workspace.repoPath)

    // A conflicting change on `main`, committed after the task's worktree branched off it.
    writeFileSync(join(workspace.repoPath, 'README.md'), 'main version\n')
    git(['add', '-A'], workspace.repoPath)
    git(['commit', '-q', '-m', 'diverge main'], workspace.repoPath)
    const mainAfterDiverge = git(['rev-parse', 'main'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('rework')
    expect(task.mergeClaimedAt).toBeNull()
    expect(task.lastRejectionReason).toContain('conflicted')

    const failures = await prisma.executionEvent.findMany({ where: { taskId, type: 'task_merge_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain('conflicted')

    // `main` never moved past the divergent commit.
    expect(git(['rev-parse', 'main'], workspace.repoPath)).toBe(mainAfterDiverge)
    expect(mainAfterDiverge).not.toBe(mainBefore)
  })

  it('sends the task back to rework when the merge command itself fails, checkout left clean', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)
    const mainBefore = git(['rev-parse', 'main'], workspace.repoPath)

    // A held index lock in the primary checkout: the rebase (in the worktree, with its own index)
    // and the checkout guard (reads only) both pass, so the failure lands on `git merge` itself --
    // the same shape as `main` moving between the rebase and the merge, or a lock collision with a
    // concurrent provisioning, but deterministic.
    const lockPath = join(workspace.repoPath, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    try {
      await runMergePass(brandWorkspaceId(workspace.id))
    } finally {
      rmSync(lockPath, { force: true })
    }

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('rework')
    expect(task.mergeClaimedAt).toBeNull()
    const failures = await prisma.executionEvent.findMany({ where: { taskId, type: 'task_merge_failed' } })
    expect(failures).toHaveLength(1)

    // `main` never moved and the primary checkout is not left mid-merge.
    expect(git(['rev-parse', 'main'], workspace.repoPath)).toBe(mainBefore)
    expect(git(['status', '--porcelain'], workspace.repoPath)).toBe('')
  })

  it('(d) sends a task with a post-rebase red verify back to rework', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['false'] })
    const { taskId } = await seedMergingTask(workspace)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('rework')
    expect(task.mergeClaimedAt).toBeNull()
    expect(task.lastRejectionReason).toContain('post-rebase verify failed')

    const failures = await prisma.executionEvent.findMany({ where: { taskId, type: 'task_merge_failed' } })
    expect(failures).toHaveLength(1)
    expect(mergeCommitSubjects(workspace.repoPath)).toEqual([])
  })

  it('(e) escalates a second merge failure on the same task into a workspace halt', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace, { fileName: 'README.md', content: 'task version\n' })

    writeFileSync(join(workspace.repoPath, 'README.md'), 'main version\n')
    git(['add', '-A'], workspace.repoPath)
    git(['commit', '-q', '-m', 'diverge main'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')

    // The same conflict, run again: `rebase --abort` restored the branch, and `main` still diverges.
    await prisma.task.update({ where: { id: taskId }, data: { status: 'merging' } })
    await runMergePass(brandWorkspaceId(workspace.id))

    const workspaceAfter = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(workspaceAfter.haltedReason).not.toBeNull()
    expect(workspaceAfter.haltedReason).toContain('failure')

    const guardrails = await prisma.executionEvent.findMany({ where: { workspaceId: workspace.id, type: 'guardrail_tripped' } })
    const mergeGuardrails = guardrails.filter(
      (event) => (event.payload as { guardrail: string }).guardrail === 'merge_failure',
    )
    expect(mergeGuardrails).toHaveLength(1)

    expect(await prisma.executionEvent.count({ where: { taskId, type: 'task_merge_failed' } })).toBe(2)
  })

  it('(f) merges two candidates in FIFO order by review-approval seq', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const first = await seedMergingTask(workspace, { title: 'First task', fileName: 'a.txt', content: 'a\n' })
    const second = await seedMergingTask(workspace, { title: 'Second task', fileName: 'b.txt', content: 'b\n' })

    await runMergePass(brandWorkspaceId(workspace.id))
    await runMergePass(brandWorkspaceId(workspace.id))

    const taskFirst = await prisma.task.findUniqueOrThrow({ where: { id: first.taskId } })
    const taskSecond = await prisma.task.findUniqueOrThrow({ where: { id: second.taskId } })
    expect(taskFirst.status).toBe('done')
    expect(taskSecond.status).toBe('done')

    const subjects = mergeCommitSubjects(workspace.repoPath)
    expect(subjects).toHaveLength(2)
    expect(subjects[0]).toContain(first.taskKey)
    expect(subjects[1]).toContain(second.taskKey)
  })

  it('(g) two concurrent passes merge exactly once', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)

    await Promise.all([runMergePass(brandWorkspaceId(workspace.id)), runMergePass(brandWorkspaceId(workspace.id))])

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(mergeCommitSubjects(workspace.repoPath)).toHaveLength(1)
  })

  /**
   * Conductor Plan 3, fix rounds 2 and 3 (C1, controller Ruling 7): a package task's worktree can
   * reach this pass with a file its package does not own changed in it -- a lockfile setup rewrote,
   * a file a verify command generated. `git rebase` refuses a dirty tree, and a refusal here is a
   * charged rework whose next run re-dirties the same file. None of those changes is on the branch,
   * so they are SET ASIDE (saved under the run's state directory, removed from the tree) and the
   * rebase and the re-verify see exactly the branch that lands. Never `git stash`: `refs/stash` is
   * shared by every worktree of the repository, the operator's own stashes included.
   */
  describe('a package worktree holding changes the branch does not (Conductor Plan 3, C1)', () => {
    const CLEAN_TREE = 'test -z "$(git status --porcelain --untracked-files=all)"'
    const previousStateDir = process.env['SLAVEOFAI_STATE_DIR']
    let stateDir = ''

    beforeAll((): void => {
      stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-merge-state-'))
      process.env['SLAVEOFAI_STATE_DIR'] = stateDir
    })

    afterAll((): void => {
      if (previousStateDir === undefined) delete process.env['SLAVEOFAI_STATE_DIR']
      else process.env['SLAVEOFAI_STATE_DIR'] = previousStateDir
      rmSync(stateDir, { recursive: true, force: true })
    })

    const runOf = async (taskId: string): Promise<{ readonly id: string; readonly worktree: string }> => {
      const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId } })
      return { id: run.id, worktree: run.worktreePath as string }
    }

    /** Makes the seeded task a governed package task that owns only `feature.txt`/`shared.txt`. */
    async function governByPackage(workspace: Workspace, taskId: string): Promise<void> {
      const pkg = await prisma.workPackage.create({
        data: {
          workspaceId: workspace.id,
          goalVersion: 1,
          key: 'feature',
          title: 'feature',
          requirementKeys: ['R1'],
          ownedPaths: ['feature.txt', 'shared.txt'],
          interface: '',
          templateId: 'tpl',
        },
      })
      await prisma.task.update({ where: { id: taskId }, data: { workPackageId: pkg.id, goalVersion: 1 } })
    }

    /** The one directory this run's foreign changes were saved to. */
    function savedDir(runId: string): string {
      const root = join(stateDir, 'runs', runId, 'set-aside')
      const entries = readdirSync(root)
      expect(entries).toHaveLength(1)
      return join(root, entries[0] as string)
    }

    /** An operator's own stash in the primary checkout, which nothing here may touch. */
    function operatorStash(repoPath: string): string {
      writeFileSync(join(repoPath, 'README.md'), '# the operator was editing this\n')
      git(['stash', 'push', '-q', '-m', 'operator work'], repoPath)
      return git(['stash', 'list'], repoPath)
    }

    const landedFiles = (repoPath: string): readonly string[] =>
      git(['diff', '--name-only', 'main^1', 'main'], repoPath).split('\n').toSorted()

    it('sets a modified tracked foreign file aside and merges, base unchanged', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE] })
      const { taskId, taskKey } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      const stashes = operatorStash(workspace.repoPath)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by setup\n')

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.lastRejectionReason).toBeNull()
      expect(task.status).toBe('done')
      expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
      expect(landedFiles(workspace.repoPath)).toEqual(['feature.txt'])
      expect(git(['show', 'main:README.md'], workspace.repoPath)).toBe('# fixture')
      expect(git(['status', '--porcelain', '--untracked-files=all'], run.worktree)).toBe('')
      expect(readFileSync(join(savedDir(run.id), 'changes.patch'), 'utf8')).toContain('rewritten by setup')
      expect(git(['stash', 'list'], workspace.repoPath)).toBe(stashes)
    })

    it('sets a modified tracked foreign file aside and merges after the base branch moved on', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE] })
      const { taskId, taskKey } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by setup\n')
      writeFileSync(join(workspace.repoPath, 'other.txt'), 'another task landed\n')
      git(['add', '-A'], workspace.repoPath)
      git(['commit', '-q', '-m', 'main moves on'], workspace.repoPath)
      const stashes = operatorStash(workspace.repoPath)

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.lastRejectionReason).toBeNull()
      expect(task.status).toBe('done')
      expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
      expect(landedFiles(workspace.repoPath)).toEqual(['feature.txt'])
      expect(git(['show', 'main:README.md'], workspace.repoPath)).toBe('# fixture')
      expect(existsSync(join(run.worktree, 'other.txt'))).toBe(true)
      expect(git(['status', '--porcelain', '--untracked-files=all'], run.worktree)).toBe('')
      expect(readFileSync(join(savedDir(run.id), 'changes.patch'), 'utf8')).toContain('rewritten by setup')
      expect(git(['stash', 'list'], workspace.repoPath)).toBe(stashes)
    })

    it('sets aside a foreign file the base branch also changed, and judges the rebased branch alone', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE, '! grep -rq "<<<<<<<" README.md'] })
      const { taskId, taskKey } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by setup\n')
      writeFileSync(join(workspace.repoPath, 'README.md'), '# fixture, as main now has it\n')
      git(['add', '-A'], workspace.repoPath)
      git(['commit', '-q', '-m', 'main changes the readme'], workspace.repoPath)

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.lastRejectionReason).toBeNull()
      expect(task.status).toBe('done')
      expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
      expect(git(['show', 'main:README.md'], workspace.repoPath)).toBe('# fixture, as main now has it')
      expect(readFileSync(join(run.worktree, 'README.md'), 'utf8')).toBe('# fixture, as main now has it\n')
      expect(readFileSync(join(savedDir(run.id), 'changes.patch'), 'utf8')).toContain('rewritten by setup')
    })

    it('sets aside an untracked foreign file whose path the base branch now tracks, and merges', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE] })
      const { taskId, taskKey } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'generated.txt'), 'left behind\n')
      writeFileSync(join(workspace.repoPath, 'generated.txt'), 'another package owns this\n')
      git(['add', '-A'], workspace.repoPath)
      git(['commit', '-q', '-m', 'another package lands generated.txt'], workspace.repoPath)
      const stashes = operatorStash(workspace.repoPath)

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.lastRejectionReason).toBeNull()
      expect(task.status).toBe('done')
      expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
      expect(landedFiles(workspace.repoPath)).toEqual(['feature.txt'])
      expect(git(['show', 'main:generated.txt'], workspace.repoPath)).toBe('another package owns this')
      expect(readFileSync(join(run.worktree, 'generated.txt'), 'utf8')).toBe('another package owns this\n')
      expect(readFileSync(join(savedDir(run.id), 'untracked', 'generated.txt'), 'utf8')).toBe('left behind\n')
      expect(git(['stash', 'list'], workspace.repoPath)).toBe(stashes)
    })

    it('sets aside a foreign file staged but never committed, so it does not land', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE] })
      const { taskId } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'staged.txt'), 'staged, never committed\n')
      git(['add', 'staged.txt'], run.worktree)

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('done')
      expect(landedFiles(workspace.repoPath)).toEqual(['feature.txt'])
      expect(existsSync(join(run.worktree, 'staged.txt'))).toBe(false)
      expect(readFileSync(join(savedDir(run.id), 'changes.patch'), 'utf8')).toContain('staged, never committed')
    })

    it('still sends a conflicting branch back to rework with HEAD unchanged', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true })
      const { taskId } = await seedMergingTask(workspace, { fileName: 'shared.txt', content: 'task version\n' })
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      const headBefore = git(['rev-parse', 'HEAD'], run.worktree)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by setup\n')
      writeFileSync(join(workspace.repoPath, 'shared.txt'), 'main version\n')
      git(['add', '-A'], workspace.repoPath)
      git(['commit', '-q', '-m', 'main writes the same file'], workspace.repoPath)
      const stashes = operatorStash(workspace.repoPath)

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('rework')
      expect(task.lastRejectionReason).toContain('conflicted')
      expect(git(['rev-parse', 'HEAD'], run.worktree)).toBe(headBefore)
      // The foreign change was set aside before the rebase, not lost.
      expect(git(['status', '--porcelain', '--untracked-files=all'], run.worktree)).toBe('')
      expect(readFileSync(join(savedDir(run.id), 'changes.patch'), 'utf8')).toContain('rewritten by setup')
      expect(git(['stash', 'list'], workspace.repoPath)).toBe(stashes)
    })

    it('leaves a task with no package exactly as before: a dirty tree still refuses the rebase', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true })
      const { taskId } = await seedMergingTask(workspace)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by hand\n')

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('rework')
      expect(task.lastRejectionReason).toContain('conflicted')
      expect(readFileSync(join(run.worktree, 'README.md'), 'utf8')).toBe('rewritten by hand\n')
      expect(existsSync(join(stateDir, 'runs', run.id))).toBe(false)
    })

    /**
     * Round 4 (re-review m2): the dirty-tree check, the ownership-rule lookup and the set-aside call
     * used to run BEFORE the rebase's own try/catch, not inside it. A worktree gone or broken threw
     * out of all three, straight out of `runMergePass`, with the merge claim still set -- every later
     * merge on the workspace stalled until the stale-merge sweep found it. A broken worktree always
     * failed the rebase itself the same way (`git rebase` in a missing directory throws too); the fix
     * is for the pre-checks to fail exactly the same way, not a new one.
     */
    it('fails the merge the same way a broken worktree always failed the rebase, claim released, when the worktree is gone before the dirty-tree check', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true })
      const { taskId } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      const mainBefore = git(['rev-parse', 'main'], workspace.repoPath)
      rmSync(run.worktree, { recursive: true, force: true })

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('rework')
      expect(task.mergeClaimedAt).toBeNull()
      const failures = await prisma.executionEvent.findMany({ where: { taskId, type: 'task_merge_failed' } })
      expect(failures).toHaveLength(1)
      // `main` never moved: the pass never reached the primary checkout at all.
      expect(git(['rev-parse', 'main'], workspace.repoPath)).toBe(mainBefore)
    })

    /**
     * Round 4 (re-review m3): a set-aside that cannot save what it would remove reports `failed`
     * rather than throwing (`setAside.ts`'s own contract: nothing removed unless everything saved).
     * Before this fix that `failed` outcome was only logged, the dirty tree was left in place, and
     * the plain rebase below refused it -- a JUDGED, charged rework for a save failure that is not
     * the work. `judged: false` still spends the attempt (`rejectTask` runs either way, exactly as
     * the primary-checkout-dirty branch below already does for the same reason) -- bounded, not a
     * free retry loop -- but never settles `integrated: false` on it, and the reason names the real
     * cause instead of a rebase conflict that never happened.
     */
    it('routes a set-aside that cannot save its changes to an uncharged-judgement rework, not a rebase conflict', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [CLEAN_TREE] })
      const { taskId } = await seedMergingTask(workspace)
      await governByPackage(workspace, taskId)
      const run = await runOf(taskId)
      writeFileSync(join(run.worktree, 'README.md'), 'rewritten by setup\n')
      // The set-aside directory's own parent exists as a plain FILE: `mkdir` cannot create it, so
      // the save fails before anything is touched in the worktree.
      mkdirSync(join(stateDir, 'runs', run.id), { recursive: true })
      writeFileSync(join(stateDir, 'runs', run.id, 'set-aside'), 'not a directory\n')

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('rework')
      expect(task.mergeClaimedAt).toBeNull()
      expect(task.attempt).toBe(1)
      expect(task.lastRejectionReason).toContain('set aside')
      expect(task.lastRejectionReason).not.toContain('conflicted')
      // Nothing was removed from the worktree: the save never happened.
      expect(readFileSync(join(run.worktree, 'README.md'), 'utf8')).toBe('rewritten by setup\n')

      const failures = await prisma.executionEvent.findMany({ where: { taskId, type: 'task_merge_failed' } })
      expect(failures).toHaveLength(1)
    })
  })
})

/**
 * M35 t2: the whole point of `integratedAt` is what it does to `world.ts`'s dependency gate for a
 * task that DOES have a dependent -- and, symmetrically, that a task with NONE is unaffected by
 * any of this. `runMergePass` alone (the block above) can't see that; these tests span
 * `merge.ts`, `world.ts` and `confirmIntegration` (`@slave-of-ai/control`) together.
 */
describe('runMergePass + loadWorld: integratedAt unblocks dependents', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(`${repo}-slaveofai-worktrees`, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  })

  /** A plain `blocked` task depending on `dependsOnTaskId` -- never provisioned, so it needs no
   *  worktree of its own; only its `dependenciesDone` reading is what these tests watch. */
  async function seedDependent(workspace: Workspace, dependsOnTaskId: string): Promise<{ readonly id: string }> {
    const dependent = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Wire it up',
        description: 'needs the other task merged first',
        status: 'blocked',
        requiredRole: 'backend',
        maxAttempts: 5,
      },
    })
    await prisma.taskDependency.create({ data: { taskId: dependent.id, dependsOnTaskId } })
    return { id: dependent.id }
  }

  async function dependenciesDoneFor(workspace: Workspace, dependentId: string): Promise<boolean | undefined> {
    const { world } = await loadWorld(brandWorkspaceId(workspace.id))
    return world.tasks.find((t) => t.id === brandTaskId(dependentId))?.dependenciesDone
  }

  it('an auto-merged task stamps integratedAt and unblocks its dependent', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)
    const dependent = await seedDependent(workspace, taskId)

    expect(await dependenciesDoneFor(workspace, dependent.id)).toBe(false)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.integratedAt).not.toBeNull()
    expect(await dependenciesDoneFor(workspace, dependent.id)).toBe(true)
  })

  it('a hand-merged task does NOT unblock its dependent until confirmIntegration', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId } = await seedMergingTask(workspace)
    const dependent = await seedDependent(workspace, taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.integratedAt).toBeNull()
    // `done`, but not integrated: the dependent stays gated, exactly the defect this task fixes.
    expect(await dependenciesDoneFor(workspace, dependent.id)).toBe(false)

    const confirmed = await confirmIntegration(taskId)
    expect(confirmed.ok).toBe(true)

    expect(await dependenciesDoneFor(workspace, dependent.id)).toBe(true)
  })

  it('a task with no dependents behaves exactly as before, whichever autoMerge path runs it', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId } = await seedMergingTask(workspace)
    // An unrelated task with no dependencies of its own, so its own vacuously-true reading is
    // provably untouched by the merge pass over a task it has nothing to do with.
    const bystander = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Unrelated work',
        description: 'shares nothing with the merging task',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 5,
      },
    })

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    // No dependents at all: `done` with a null `integratedAt` is the exact same outcome this task
    // reached before `integratedAt` existed -- nothing reads the column for it.
    expect(task.status).toBe('done')
    expect(task.integratedAt).toBeNull()

    const { world } = await loadWorld(brandWorkspaceId(workspace.id))
    expect(world.tasks.find((t) => t.id === brandTaskId(bystander.id))?.dependenciesDone).toBe(true)
  })

  // M48 R6, fix round 1 (controller ruling): a rebase can change behaviour without a textual
  // conflict, and what a stage's gate proves is exactly as true of the rebased tree as of the one
  // review read. So the post-rebase re-verify runs the stage's gates too -- which does mean a gate
  // runs twice for a clean merge, once at verify and once here. That is intended.
  describe('stage gates on the post-rebase re-verify (M48 R6)', () => {
    const KEY = 'gate-m48-merge'

    /** One stage, whichever gates the case wants. Written through `addRunbook` the first time --
     *  the verb is what validates a stage list -- and its gates set directly afterwards, because
     *  the row outlives this file's TRUNCATE. */
    async function adoptGateRunbook(workspaceId: string, gates: readonly string[]): Promise<void> {
      const existing = await prisma.runbookTemplate.findUnique({ where: { key: KEY } })
      if (existing === null) {
        const added = await addRunbook({
          key: KEY,
          name: 'Gate merge',
          description: 'x',
          stages: [{ key: 'implement', title: 'Implement', objective: 'Build', gates: [...gates] }],
        })
        expect(added.ok).toBe(true)
      } else {
        await prisma.runbookTemplate.update({
          where: { key: KEY },
          data: {
            stages: [
              {
                key: 'implement',
                title: 'Implement',
                objective: 'Build',
                capabilities: [],
                dependsOn: [],
                expectedOutputs: [],
                gates: [...gates],
                retry: null,
                escalation: null,
              },
            ],
          },
        })
      }
      expect((await adoptRunbook(workspaceId, KEY)).ok).toBe(true)
    }

    afterAll(async (): Promise<void> => {
      await prisma.runbookTemplate.deleteMany({ where: { key: KEY } })
    })

    it('fails the merge when the stage gate fails, and names the stage in the reason', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['true'] })
      await adoptGateRunbook(workspace.id, ['false'])
      const { taskId } = await seedMergingTask(workspace, { stage: 'implement' })

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).not.toBe('done')
      const failure = await prisma.executionEvent.findFirstOrThrow({
        where: { taskId, type: 'task_merge_failed' },
      })
      expect((failure.payload as { reason: string }).reason).toBe(
        'post-rebase verify failed: stage "implement" gate false exited 1',
      )
      // Nothing reached the base branch.
      expect(mergeCommitSubjects(workspace.repoPath)).toHaveLength(0)

      // The workspace's own `true` ran first and passed; the stage's `false` ran second.
      const mergeDir = join(workspace.repoPath, '.slaveofai', 'artifacts', taskId, 'merge')
      const artifacts = await prisma.artifact.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })
      expect(artifacts).toHaveLength(2)
      for (const artifact of artifacts) expect(artifact.path).toContain(mergeDir)
      expect(readFileSync(artifacts[1]?.path ?? '', 'utf8')).toContain('stage "implement" gate')
    })

    it('merges a staged task whose gate passes', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['true'] })
      // A DIFFERENT command from the workspace's own, deliberately: a gate byte-equal to a verify
      // command is dropped and run once (M48 final review, Minor 4), so `['true']` here would prove
      // the gate ran when it had in fact been deduped away.
      await adoptGateRunbook(workspace.id, ['echo staged'])
      const { taskId, taskKey } = await seedMergingTask(workspace, { stage: 'implement' })

      await runMergePass(brandWorkspaceId(workspace.id))

      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('done')
      expect(task.integratedAt).not.toBeNull()
      expect(mergeCommitSubjects(workspace.repoPath).some((subject) => subject.includes(taskKey))).toBe(true)
      // Both commands ran: the workspace's own and the stage's gate.
      expect(await prisma.artifact.count({ where: { taskId } })).toBe(2)
    })

    // M48 final review, Minor 4, on the post-rebase pass: the same command in both lists is one run.
    it('runs a gate the workspace already runs exactly once on the rebased tree', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['true'] })
      await adoptGateRunbook(workspace.id, ['true'])
      const { taskId } = await seedMergingTask(workspace, { stage: 'implement' })

      await runMergePass(brandWorkspaceId(workspace.id))

      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
      expect(await prisma.artifact.count({ where: { taskId } })).toBe(1)
    })

    it('leaves an UNSTAGED task exactly as it was: the workspace commands and nothing else', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['true'] })
      await adoptGateRunbook(workspace.id, ['false'])
      const { taskId } = await seedMergingTask(workspace)

      await runMergePass(brandWorkspaceId(workspace.id))

      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
      expect(await prisma.artifact.count({ where: { taskId } })).toBe(1)
    })

    it('names no stage when a WORKSPACE command fails on a staged task', async (): Promise<void> => {
      const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['exit 7'] })
      await adoptGateRunbook(workspace.id, ['true'])
      const { taskId } = await seedMergingTask(workspace, { stage: 'implement' })

      await runMergePass(brandWorkspaceId(workspace.id))

      const failure = await prisma.executionEvent.findFirstOrThrow({
        where: { taskId, type: 'task_merge_failed' },
      })
      expect((failure.payload as { reason: string }).reason).toBe('post-rebase verify failed: exit 7 exited 7')
    })
  })
})

/**
 * M53 R4, the last two of the four verdicts: integration settles only where work actually reached
 * the base branch.
 *
 * The `!autoMerge` path settles NOTHING, on purpose. M35 spent a milestone on that distinction --
 * it writes `integratedAt: null` explicitly, because no git merge happened -- and
 * `confirmIntegration` is the verdict for that task, days later, when a person says the branch
 * really landed.
 */
describe('integration settles only where work actually reached the base branch (M53 R4)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(`${repo}-slaveofai-worktrees`, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  /** The task's own implementation run, and the fact the pump wrote when it concluded. */
  async function implEvidenceFor(taskId: string): Promise<string> {
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId, kind: 'implementation' } })
    await recordRunEvidence(run.id)
    return run.id
  }

  it('settles true on an AUTO-MERGE, where `integratedAt` is written', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(true)
  })

  it('settles NOTHING on the !autoMerge path, which writes `integratedAt: null` deliberately', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).integratedAt).toBeNull()
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })

  it('settles NOTHING on a post-rebase gate that said no while the task can still be re-done (E24)', async (): Promise<void> => {
    // `failMerge` caller 2, `result.kind === 'failed'`: the gate ran against the rebased tree and
    // turned it down -- so the work IS judged. It is not yet a verdict: the task goes back to
    // `rework` with four attempts left, and a gate that fails once and passes the second time is
    // the ordinary case. A `false` written here could never be taken back (E1), and this column is
    // the ranker's third rate.
    const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['exit 7'] })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    expect(await eventTypesFor(workspace.id)).toContain('task.merge_failed')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })

  it('settles FALSE when that same gate failure spends the task’s LAST attempt (E24)', async (): Promise<void> => {
    // The integration ENDS here: the task is `failed`, nothing will merge this work, and "it never
    // reached the base branch" is a fact rather than a guess about the next attempt.
    const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: ['exit 7'] })
    const { taskId } = await seedMergingTask(workspace, { maxAttempts: 1 })
    const implRunId = await implEvidenceFor(taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('failed')
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(false)
  })

  it('settles NOTHING on a rebase that CONFLICTED, and TRUE when the work later lands (E24)', async (): Promise<void> => {
    // `failMerge` caller 1. The base branch moved under the task: `main` now touches the same line
    // the task's own commit does, so the rebase cannot replay it. That is judged -- the branch is
    // what does not fit -- and it is also the most retryable failure there is: somebody resolves
    // the conflict and the same work lands. E24's whole point is the SECOND half of this case: the
    // column is still null, so the later merge settles `true` over it as a first settle, which E1
    // permits and which a `false` written at the conflict would have made impossible forever.
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace, { fileName: 'clash.txt', content: 'from the task\n' })
    const implRunId = await implEvidenceFor(taskId)
    writeFileSync(join(workspace.repoPath, 'clash.txt'), 'from main\n')
    git(['add', '-A'], workspace.repoPath)
    git(['commit', '-q', '-m', 'main touched the same file'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_merge_failed' } })
    expect((failure.payload as { reason: string }).reason).toMatch(/conflicted/u)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBeNull()

    // The retry, made literal: the work reaches the base branch on a later pass.
    await settleTaskEvidence(taskId, { kind: 'integration', integrated: true })

    const settled = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(settled.integrated).toBe(true)
    expect(settled.settledAt).not.toBeNull()
  })

  it('settles NOTHING when the post-rebase verify could not RUN -- that is not the worker being judged', async (): Promise<void> => {
    // `failMerge` caller 2, `result.kind === 'not_configured'`: a workspace with no verify commands
    // has proved nothing about this branch, and `runVerify` refuses to read that as a pass. Before
    // this round the merge pass settled `false` for it -- which, because `integrated` feeds the
    // ranker's third rate and a judgement column can never move back off a verdict, would have
    // marked down EVERY worker in a misconfigured project, permanently.
    const workspace = await seedWorkspace({ autoMerge: true, verifyCommands: [] })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)

    await runMergePass(brandWorkspaceId(workspace.id))

    expect(await eventTypesFor(workspace.id)).toContain('task.merge_failed')
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })

  it('settles NOTHING when the shared checkout is dirty -- no worker did that', async (): Promise<void> => {
    // `failMerge` caller 3. The primary checkout is shared by every task in the workspace; somebody
    // left a file in it, or left it on another branch. The task's branch was never even looked at.
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)
    writeFileSync(join(workspace.repoPath, 'somebody-left-this.txt'), 'uncommitted\n')

    await runMergePass(brandWorkspaceId(workspace.id))

    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_merge_failed' } })
    expect((failure.payload as { reason: string }).reason).toMatch(/primary checkout is not clean/u)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })

  it('settles true when a person confirms a hand merge, days later', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)
    await runMergePass(brandWorkspaceId(workspace.id))

    // `confirmIntegration`'s own settle landed in Task 2; this is the pair of paths meeting, which
    // is the whole reason the !autoMerge path may not settle a `false` of its own.
    await confirmIntegration(taskId)

    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(true)
  })

  it('settles the integration column once, however many merge passes see the task', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const { taskId } = await seedMergingTask(workspace)
    const implRunId = await implEvidenceFor(taskId)
    await runMergePass(brandWorkspaceId(workspace.id))
    const first = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })

    // The retried tick, made literal: the site's own call, made a second time. `applySettle` writes
    // each column through an `updateMany` conditioned on THAT column being null, so a verdict moves
    // it from null exactly once and a replayed pass writes nothing.
    await settleTaskEvidence(taskId, { kind: 'integration', integrated: true })

    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })
    expect(row.integrated).toBe(true)
    expect(row.settledAt).toEqual(first.settledAt)
  })
})

/**
 * Conductor Plan 4a, Task 4 (spec R9, §5; plan D2, D3, D4, D7): a package task of a goal version
 * with a `GoalDelivery` merges into that version's integration branch, in the worktree kept on it,
 * whatever `autoMerge` says -- never into the base branch, never in the person's primary checkout.
 * A second merge failure blocks that package alone; the workspace keeps going.
 */
describe('into the integration branch', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(`${repo}-slaveofai-worktrees`, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  /** Goal version 1's integration branch and delivery row, exactly as the conductor leaves them. */
  async function deliver(workspace: Workspace): Promise<IntegrationTarget> {
    const branch = integrationBranchName(1, workspace.id)
    const { baseCommit } = await ensureIntegrationBranch(workspace.repoPath, 'main', branch)
    const delivery = await prisma.goalDelivery.create({
      data: { workspaceId: workspace.id, goalVersion: 1, integrationBranch: branch, baseCommit },
    })
    return { deliveryId: delivery.id, goalVersion: 1, branch }
  }

  /** Makes a seeded task a package task of goal version 1. */
  async function packageTask(workspace: Workspace, taskId: string, key: string): Promise<void> {
    const pkg = await prisma.workPackage.create({
      data: {
        workspaceId: workspace.id,
        goalVersion: 1,
        key,
        title: key,
        requirementKeys: ['R1'],
        ownedPaths: ['**'],
        interface: '',
        templateId: 'tpl',
      },
    })
    await prisma.task.update({ where: { id: taskId }, data: { workPackageId: pkg.id, goalVersion: 1 } })
  }

  /** Commits `file` onto `branch` from a scratch worktree, leaving the primary checkout alone. */
  function commitOnto(repo: string, branch: string, file: string, content: string): void {
    const dir = join(mkdtempSync(join(tmpdir(), 'slaveofai-merge-scratch-')), 'tree')
    git(['worktree', 'add', '-q', dir, branch], repo)
    writeFileSync(join(dir, file), content)
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', `add ${file}`], dir)
    git(['worktree', 'remove', '--force', dir], repo)
  }

  const isAncestor = (repo: string, ancestor: string, of: string): boolean => {
    try {
      git(['merge-base', '--is-ancestor', ancestor, of], repo)
      return true
    } catch {
      return false
    }
  }

  it('merges a package into its integration branch with autoMerge off, and leaves main and the checkout alone', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const target = await deliver(workspace)
    const { taskId, branch } = await seedMergingTask(workspace)
    await packageTask(workspace, taskId, 'feature')
    const implRun = await prisma.slaveRun.findFirstOrThrow({ where: { taskId, kind: 'implementation' } })
    await recordRunEvidence(implRun.id)
    const mainBefore = git(['rev-parse', 'main'], workspace.repoPath)
    const headBefore = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.integratedAt).not.toBeNull()
    expect(task.mergeClaimedAt).toBeNull()
    expect(isAncestor(workspace.repoPath, branch, target.branch)).toBe(true)
    expect(isAncestor(workspace.repoPath, branch, 'main')).toBe(false)
    expect(git(['rev-parse', 'main'], workspace.repoPath)).toBe(mainBefore)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.repoPath)).toBe(headBefore)
    expect(git(['status', '--porcelain'], workspace.repoPath)).toBe('')
    // Plan D4: the integration EVIDENCE waits for the final merge into the base branch.
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRun.id } })).integrated).toBeNull()
    // The integration worktree is the one helper's path, checked out on the integration branch.
    const path = integrationWorktreePath(workspace.repoPath, 1, workspace.id)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], path)).toBe(target.branch)
  })

  it('does not land a package of an abandoned goal version: it is cancelled, and nothing is merged', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    await prisma.goalDelivery.update({ where: { id: target.deliveryId }, data: { status: 'abandoned' } })
    const { taskId, branch } = await seedMergingTask(workspace)
    await packageTask(workspace, taskId, 'feature')
    const integrationBefore = git(['rev-parse', target.branch], workspace.repoPath)
    const mainBefore = git(['rev-parse', 'main'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('cancelled')
    expect(task.mergeClaimedAt).toBeNull()
    expect(task.integratedAt).toBeNull()
    expect(git(['rev-parse', target.branch], workspace.repoPath)).toBe(integrationBefore)
    expect(git(['rev-parse', 'main'], workspace.repoPath)).toBe(mainBefore)
    expect(isAncestor(workspace.repoPath, branch, target.branch)).toBe(false)
    expect(existsSync(integrationWorktreePath(workspace.repoPath, 1, workspace.id))).toBe(false)
    const cancelled = await prisma.executionEvent.findMany({ where: { workspaceId: workspace.id, type: 'task_cancelled' } })
    expect(cancelled.map((event) => event.taskId)).toEqual([taskId])
    expect(await prisma.executionEvent.count({ where: { workspaceId: workspace.id, type: 'task_merge_failed' } })).toBe(0)
  })

  it('merges two packages one after another, each with its own merge commit', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    const first = await seedMergingTask(workspace, { title: 'First', fileName: 'a.txt', content: 'a\n' })
    await packageTask(workspace, first.taskId, 'a')
    const second = await seedMergingTask(workspace, { title: 'Second', fileName: 'b.txt', content: 'b\n' })
    await packageTask(workspace, second.taskId, 'b')

    await runMergePass(brandWorkspaceId(workspace.id))
    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: first.taskId } })).status).toBe('done')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: second.taskId } })).status).toBe('done')
    expect(isAncestor(workspace.repoPath, first.branch, target.branch)).toBe(true)
    expect(isAncestor(workspace.repoPath, second.branch, target.branch)).toBe(true)
    const merges = git(['rev-list', '--merges', `main..${target.branch}`], workspace.repoPath).split('\n').filter((line) => line !== '')
    expect(merges).toHaveLength(2)
    expect(mergeCommitSubjects(workspace.repoPath)).toEqual([])
  })

  it('sends a first conflict back to rework, then blocks only that package on the second', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    commitOnto(workspace.repoPath, target.branch, 'a.txt', 'the integration branch says this\n')
    const { taskId, taskKey } = await seedMergingTask(workspace, { fileName: 'a.txt', content: 'the task says that\n' })
    await packageTask(workspace, taskId, 'feature')

    await runMergePass(brandWorkspaceId(workspace.id))

    const afterFirst = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(afterFirst.status).toBe('rework')
    expect(afterFirst.attempt).toBe(1)
    expect(await eventTypesFor(workspace.id)).toContain('task.merge_failed')
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).haltedReason).toBeNull()

    await prisma.task.update({ where: { id: taskId }, data: { status: 'merging' } })
    await runMergePass(brandWorkspaceId(workspace.id))

    const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(afterSecond.status).toBe('blocked')
    expect(afterSecond.mergeClaimedAt).toBeNull()
    expect(afterSecond.lastRejectionReason).toMatch(/conflicted/u)
    expect(afterSecond.lastRejectionReason).toContain(target.branch)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).haltedReason).toBeNull()
    const trips = (await prisma.executionEvent.findMany({ where: { workspaceId: workspace.id, type: 'guardrail_tripped' } })).filter(
      (event) => (event.payload as { guardrail: string }).guardrail === 'merge_failure',
    )
    expect(trips).toHaveLength(1)
    expect(trips[0]?.taskId).toBe(taskId)
    const detail = (trips[0]?.payload as { detail: string }).detail
    expect(detail).toContain('goal v1')
    expect(detail).toContain(taskKey)
    // The way out, in the CLI's own words.
    expect(detail).toContain(`unblock-task --task ${taskId}`)
    expect(detail).toContain(`abandon-goal --workspace ${workspace.id} --version 1`)
  })

  // Controller ruling Q4 (Plan 4a note M3): "a second failure" is a second failure of THIS try at
  // merging -- never the sweep's "merge interrupted" (a dead process, not the branch), and never a
  // failure from before the package was last done and then sent back by a verification round.
  it('counts only real merge failures since the task was last reworked by verification', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    commitOnto(workspace.repoPath, target.branch, 'a.txt', 'the integration branch says this\n')
    const { taskId } = await seedMergingTask(workspace, { fileName: 'a.txt', content: 'the task says that\n' })
    await packageTask(workspace, taskId, 'feature')
    await appendEvent({ type: 'task.merge_failed', workspaceId: workspace.id, taskId, actor: 'system', payload: { reason: 'merge interrupted' } })

    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')

    // It got merged after all, was verified, and a failing requirement sent it back.
    await appendEvent({ type: 'task.done', workspaceId: workspace.id, taskId, actor: 'system', payload: { branch: 'x' } })
    await appendEvent({
      type: 'task.rework',
      workspaceId: workspace.id,
      taskId,
      actor: 'system',
      payload: { reason: 'Verification round 1 found ...', attempt: 1, verificationRound: 1 },
    })
    await prisma.task.update({ where: { id: taskId }, data: { status: 'merging' } })
    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')

    await prisma.task.update({ where: { id: taskId }, data: { status: 'merging' } })
    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('blocked')
  })

  it('still halts the workspace on a second failure of a planned task (no package)', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    await deliver(workspace)
    const { taskId } = await seedMergingTask(workspace, { fileName: 'README.md', content: 'task version\n' })
    writeFileSync(join(workspace.repoPath, 'README.md'), 'main version\n')
    git(['add', '-A'], workspace.repoPath)
    git(['commit', '-q', '-m', 'diverge main'], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))
    await prisma.task.update({ where: { id: taskId }, data: { status: 'merging' } })
    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).haltedReason).toContain('repeated merge failure')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
  })

  it('aborts a merge a crash left in the integration worktree, then merges the package', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    const path = await ensureIntegrationWorktree(workspace.repoPath, target, workspace.id)
    git(['branch', 'stray', 'main'], workspace.repoPath)
    commitOnto(workspace.repoPath, 'stray', 'stray.txt', 'half-merged\n')
    git(['merge', '--no-ff', '--no-commit', 'stray'], path)
    expect(existsSync(join(git(['rev-parse', '--git-dir'], path), 'MERGE_HEAD'))).toBe(true)
    const { taskId, branch } = await seedMergingTask(workspace)
    await packageTask(workspace, taskId, 'feature')

    await runMergePass(brandWorkspaceId(workspace.id))

    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
    expect(isAncestor(workspace.repoPath, branch, target.branch)).toBe(true)
    expect(isAncestor(workspace.repoPath, 'stray', target.branch)).toBe(false)
    expect(git(['status', '--porcelain'], path)).toBe('')
  })

  it('aborts the integration merge git refused, leaving the integration worktree clean with no MERGE_HEAD', async (): Promise<void> => {
    // The rebase onto the integration branch succeeds (it has no a.txt yet); the post-rebase verify
    // then commits a clashing a.txt onto the integration branch -- the branch moving between the
    // rebase and the merge -- so the failure lands on `git merge` itself, mid-merge, in its catch.
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    const path = await ensureIntegrationWorktree(workspace.repoPath, target, workspace.id)
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        verifyCommands: [
          `if [ ! -f ${path}/a.txt ]; then printf 'moved\\n' > ${path}/a.txt && git -C ${path} add a.txt && git -C ${path} commit -q -m moved; fi`,
        ],
      },
    })
    const { taskId } = await seedMergingTask(workspace, { fileName: 'a.txt', content: 'the task says this\n' })
    await packageTask(workspace, taskId, 'feature')
    const implRun = await prisma.slaveRun.findFirstOrThrow({ where: { taskId, kind: 'implementation' } })
    await recordRunEvidence(implRun.id)
    const integrationBefore = git(['rev-parse', target.branch], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('rework')
    expect(task.mergeClaimedAt).toBeNull()
    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_merge_failed' } })
    expect((failure.payload as { reason: string }).reason).toContain(`into ${target.branch} failed`)
    expect(git(['rev-parse', target.branch], workspace.repoPath)).not.toBe(integrationBefore)
    expect(git(['status', '--porcelain'], path)).toBe('')
    expect(existsSync(join(git(['rev-parse', '--git-dir'], path), 'MERGE_HEAD'))).toBe(false)
  })

  it('says where to look when the integration branch is checked out in the primary checkout', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: true })
    const target = await deliver(workspace)
    const { taskId } = await seedMergingTask(workspace)
    await packageTask(workspace, taskId, 'feature')
    // The person has the integration branch checked out: `worktree add` refuses it.
    git(['checkout', '-q', target.branch], workspace.repoPath)

    await runMergePass(brandWorkspaceId(workspace.id))

    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_merge_failed' } })
    const reason = (failure.payload as { reason: string }).reason
    expect(reason).toMatch(/could not prepare the integration worktree/u)
    expect(reason).toContain('may be checked out in another worktree or the primary checkout')
  })

  it('charges no judgement when the integration worktree cannot be prepared -- the machine failed, not the work', async (): Promise<void> => {
    // A directory at the integration worktree's path that is not a worktree of this repository:
    // `ensureIntegrationWorktree` refuses it before any merge. With one attempt left, a JUDGED
    // failure would settle `integrated: false` on the worker (E24); an unjudged one settles nothing.
    const workspace = await seedWorkspace({ autoMerge: true })
    await deliver(workspace)
    mkdirSync(integrationWorktreePath(workspace.repoPath, 1, workspace.id), { recursive: true })
    const { taskId } = await seedMergingTask(workspace, { maxAttempts: 1 })
    await packageTask(workspace, taskId, 'feature')
    const implRun = await prisma.slaveRun.findFirstOrThrow({ where: { taskId, kind: 'implementation' } })
    await recordRunEvidence(implRun.id)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('failed')
    expect(task.mergeClaimedAt).toBeNull()
    const failure = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_merge_failed' } })
    expect((failure.payload as { reason: string }).reason).toMatch(/integration worktree/u)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRun.id } })).integrated).toBeNull()
  })
})
