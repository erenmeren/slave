import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { workspaceId as brandWorkspaceId, taskId as brandTaskId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { addRunbook, adoptRunbook, confirmIntegration, recordRunEvidence, settleTaskEvidence } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
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
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] } })
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
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
