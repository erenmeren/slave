import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/**
 * Spec §16, the milestone gate. Every step is driven from the CLI, because "M3 is done when, from
 * the CLI" is the sentence the gate opens with -- an in-process shortcut would prove a different
 * product than the one an operator runs. Against the fake `claude` here; §16 additionally requires
 * steps 3-4 once by hand against the real CLI, recorded under docs/superpowers/spikes/.
 *
 * Extended for M8a (Task 8's flip): the same CLI-driven discipline now has to prove the pipeline
 * past its old M3 finish line -- `verifying -> reviewing -> merging -> done`, unattended, driven by
 * nothing but repeated `tick`s. Task 4's `m8a-flow` fake-CLI mode is what makes that real end to
 * end: a work run leaves a real commit for the merge pass to merge, and a review run is told apart
 * from a work run by the literal `"verdict"` substring `buildReviewPrompt` always includes.
 */
async function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
        ...extraEnv,
      },
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: shaped.stdout ?? '', stderr: shaped.stderr ?? '', code: shaped.code ?? 1 }
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly repoPath: string
}

const repos: string[] = []

async function seed(options: {
  readonly verifyCommands: readonly string[]
  readonly setupCommands?: readonly string[]
  readonly autoMerge?: boolean
}): Promise<Fixture> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: [...options.verifyCommands],
      setupCommands: [...(options.setupCommands ?? [])],
      autoMerge: options.autoMerge ?? false,
    },
  })
  // M12 Task 8: no agent in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here (the real CLI, `dist/cli.js`) refuses instead of
  // starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, taskId: task.id, repoPath }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

/** Asserts `earlier` and `later` both happened, in that order. An index of -1 fails both ways. */
function expectOrdered(types: readonly DomainEventType[], earlier: DomainEventType, later: DomainEventType): void {
  const first = types.indexOf(earlier)
  const second = types.indexOf(later)
  expect(first, `${earlier} was never emitted`).toBeGreaterThanOrEqual(0)
  expect(second, `${later} was never emitted`).toBeGreaterThan(first)
}

/** Adds a `reviewer`-role agent to the fixture's one team, idle and ready to be picked up. */
async function addReviewer(): Promise<void> {
  const team = await prisma.team.findFirstOrThrow()
  await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })
}

describe('the M3/M8a milestone gate', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 30_000)

  it('green M8a: verify passed enters review, an approval merges the branch — unattended, autoMerge true', async (): Promise<void> => {
    // The verify command doubles as the proof that setup ran *in the worktree*: it can only pass
    // where provisioning ran the setup command first, so a verify green here is steps 2 and 5 of
    // §16 observed through one another rather than asserted separately on trust.
    const fixture = await seed({
      setupCommands: ['echo ran > setup-marker'],
      verifyCommands: ['test -f setup-marker'],
      autoMerge: true,
    })
    await addReviewer()

    // Task 4's synthetic mode: a work run leaves a real commit for the merge pass to merge, and a
    // review run replays `review-approve`. Selected the same way production would select it.
    const m8aFlow = { SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture m8a-flow` }

    // Repeated ticks, not the daemon: `dispatchReviews` and `runMergePass` (Tasks 5 and 7) each run
    // once per tick, after whatever that same tick started -- so a review or a merge only becomes
    // visible to the *next* tick's pass. One tick starts the work run and lands it in `reviewing`,
    // one dispatches and concludes the review, one lets `runMergePass` see the now-`merging` task
    // and merge it. The loop is generous about the count rather than hardcoding three.
    let task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    for (let i = 0; i < 6 && task.status !== 'done'; i += 1) {
      const result = await runCli(['tick'], m8aFlow)
      expect(result.code).toBe(0)
      task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    }

    // Step 1-2: picked up by a tick, worktree provisioned, setup ran in it.
    const implRun = await prisma.agentRun.findFirstOrThrow({ where: { kind: 'implementation' } })
    expect(implRun.status).toBe('succeeded')
    expect(implRun.pid).toBeGreaterThan(0)
    expect(implRun.worktreePath).toContain(join('.slaveofai', 'worktrees'))
    expect(existsSync(join(implRun.worktreePath ?? '', 'setup-marker'))).toBe(true)

    expect(task.status).toBe('done')
    expect(task.branch).toMatch(/^slaveofai\//)
    expect(task.activeRunId).toBeNull()

    // The M8a order (spec §3.2/§8, Tasks 5 and 7): verify strictly after the task started, review
    // strictly after verify passed, approval strictly after review started, done strictly after
    // approval -- the whole pipeline this milestone exists to prove reaches unattended.
    const types = await eventTypesFor(fixture.workspaceId)
    expectOrdered(types, 'task.started', 'task.verifying')
    // The first `run.succeeded` is the implementation run's: verify must come strictly after the
    // run concluded, not race it -- the pre-flip gate pinned this and the flip must not lose it.
    expectOrdered(types, 'run.succeeded', 'task.verifying')
    expectOrdered(types, 'task.verifying', 'task.verify_passed')
    expectOrdered(types, 'task.verify_passed', 'task.review_started')
    expectOrdered(types, 'task.review_started', 'task.review_approved')
    expectOrdered(types, 'task.review_approved', 'task.done')

    // The merge pass actually merged, not just marked the task done: a `--no-ff` commit for this
    // task sits on `main` in the primary checkout.
    const taskKey = `T-${fixture.taskId.slice(0, 8)}`
    const mergeSubjects = execFileSync('git', ['log', '--merges', '--format=%s'], {
      cwd: fixture.repoPath,
      encoding: 'utf8',
    })
    expect(mergeSubjects).toContain(`merge(${taskKey})`)
  }, 60_000)

  it('autoMerge false: the same unattended flow ends done, branch preserved, no merge commit', async (): Promise<void> => {
    const fixture = await seed({ verifyCommands: ['true'], autoMerge: false })
    await addReviewer()
    const m8aFlow = { SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture m8a-flow` }

    let task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    for (let i = 0; i < 6 && task.status !== 'done'; i += 1) {
      const result = await runCli(['tick'], m8aFlow)
      expect(result.code).toBe(0)
      task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    }

    // spec Decision 5: a workspace that does not trust auto-merge still wants the task marked done
    // and out of the queue -- but with the branch and worktree left for a human to merge by hand.
    expect(task.status).toBe('done')
    expect(task.branch).toMatch(/^slaveofai\//)

    // Still the full M8a pipeline, not verify short-circuiting straight to `done`: a review really
    // ran and approved it. Without this, `autoMerge: false` landing on `done` says nothing --
    // that was also true of the pre-Task-8 verify green path this test exists to distinguish from.
    const types = await eventTypesFor(fixture.workspaceId)
    expectOrdered(types, 'task.verify_passed', 'task.review_started')
    expectOrdered(types, 'task.review_started', 'task.review_approved')
    expectOrdered(types, 'task.review_approved', 'task.done')

    const mergeSubjects = execFileSync('git', ['log', '--merges', '--format=%s'], {
      cwd: fixture.repoPath,
      encoding: 'utf8',
    }).trim()
    expect(mergeSubjects).toBe('')
    const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: fixture.repoPath,
      encoding: 'utf8',
    })
    expect(branches).toContain(task.branch)
  }, 60_000)

  it('red: a failing verify sends the task to rework with the failure attached', async (): Promise<void> => {
    const fixture = await seed({ verifyCommands: ['echo BOOM >&2; exit 1'] })

    const result = await runCli(['tick'])

    expect(result.code).toBe(0)

    // The agent's run itself was fine — it is the *work* that failed verification. A gate that
    // conflated the two could pass with verify never wired at all, failing runs standing in for
    // failing work.
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('succeeded')

    const types = await eventTypesFor(fixture.workspaceId)
    expectOrdered(types, 'task.verifying', 'task.verify_failed')
    expectOrdered(types, 'task.verify_failed', 'task.rework')

    // Step 6, red: rework with the failure attached — §8's channel to the next run's prompt.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
    expect(task.lastRejectionReason).toContain('BOOM')
  }, 60_000)

  it('pause: the run pauses on the gate, checkpoints, and resumes into review', async (): Promise<void> => {
    const fixture = await seed({ verifyCommands: ['true'] })

    // A real pause, produced by the gate denying the fake CLI's tool call — the same protocol the
    // real `claude` follows, which is what lets §16 run this step against either.
    await runCli(['tick'], { SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture hook-deny` })

    const paused = await prisma.agentRun.findFirstOrThrow()
    expect(paused.status).toBe('paused')

    // Step 4: the checkpoint written from the pause carries what a fresh process needs to resume.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: paused.id } })
    expect(checkpoint.sessionId).not.toBe('')
    expect(checkpoint.worktreePath).toContain('.slaveofai')

    const result = await runCli(['resume', '--run', paused.id], {
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
    })

    expect(result.code).toBe(0)

    // The resumed run completes — and its completion is a completion like any other: verify runs
    // on it and the task advances into review (M8a). A resumed run whose success leaves the task
    // `running` forever would make pause/resume a trap rather than a control.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: paused.id } })
    expect(run.status).toBe('succeeded')
    expect(run.terminalAt).not.toBeNull()

    const types = await eventTypesFor(fixture.workspaceId)
    expect(types).toContain('run.paused')
    expect(types).toContain('run.resumed')
    expectOrdered(types, 'run.resumed', 'task.verify_passed')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
  }, 60_000)
})
