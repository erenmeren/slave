import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runMergePass } from '../../src/merge.js'
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
  readonly agentId: string
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
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { id: workspace.id, repoPath, agentId: agent.id }
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
  input: { readonly title?: string; readonly fileName?: string; readonly content?: string } = {},
): Promise<MergingTask> {
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: input.title ?? 'Add the thing',
      description: 'make it work',
      status: 'merging',
      requiredRole: 'backend',
      maxAttempts: 5,
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
  const run = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      agentId: workspace.agentId,
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
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

  it('(b) concludes done without merging when autoMerge is false', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    const { taskId, branch } = await seedMergingTask(workspace)

    await runMergePass(brandWorkspaceId(workspace.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('done')
    expect(task.mergeClaimedAt).toBeNull()

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
})
