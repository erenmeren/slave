import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { collectTaskWorktree, terminalTimestamp } from '../../src/collect.js'
import { refusalText } from '../../src/refusal.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

const BRANCH = 'aiteamos/T-abc-x'

/**
 * A real repository with `.aiteamos/.gitignore` already in place (mirrors `ensureIgnored` in
 * `apps/orchestrator/src/worktree.ts`, which this package does not depend on) and one real
 * worktree on its own branch -- exactly the shape `provisionWorktree` leaves behind, built
 * directly with git so this suite proves `collectTaskWorktree` against the real thing rather than
 * a mock asserting its own script.
 */
function makeRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-collect-'))
  run('git', ['init', '-q', '-b', 'main'], repoPath)
  run('git', ['config', 'user.name', 'Fixture'], repoPath)
  run('git', ['config', 'user.email', 'fixture@example.com'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], repoPath)
  run('git', ['commit', '-q', '-m', 'initial'], repoPath)

  const aiteamosRoot = join(repoPath, '.aiteamos')
  mkdirSync(aiteamosRoot, { recursive: true })
  writeFileSync(join(aiteamosRoot, '.gitignore'), '*\n')

  const worktreePath = join(aiteamosRoot, 'worktrees', 'T-abc')
  run('git', ['worktree', 'add', '-b', BRANCH, worktreePath], repoPath)

  return { repoPath, worktreePath }
}

interface Fixture {
  readonly repoPath: string
  readonly worktreePath: string
  readonly workspaceId: string
  readonly taskId: string
  readonly agentId: string
  readonly runId: string
}

const repos: string[] = []

/**
 * One task, one agent, one run -- the run carries `worktreePath` by default, matching a terminal
 * task whose worktree is still on disk. Every case below overrides only what it needs to (task
 * status, run status/pid, whether the run carries a path at all) rather than re-deriving the
 * whole fixture, the same shape `cli.test.ts`'s `seed(overrides)` uses.
 */
async function seed(
  overrides: {
    readonly taskStatus?: string
    readonly runStatus?: string
    readonly runPid?: number | null
    readonly withWorktreePath?: boolean
  } = {},
): Promise<Fixture> {
  const { repoPath, worktreePath } = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: { name: `Checkout ${repos.length}`, repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: (overrides.taskStatus ?? 'done') as never,
      branch: BRANCH,
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const agentRun = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      agentId: agent.id,
      status: (overrides.runStatus ?? 'succeeded') as never,
      pid: overrides.runPid ?? null,
      worktreePath: overrides.withWorktreePath === false ? null : worktreePath,
    },
  })
  await appendEvent({
    type: 'task.done',
    workspaceId: workspace.id,
    taskId: task.id,
    agentId: agent.id,
    runId: agentRun.id,
    actor: 'agent',
    payload: { branch: BRANCH },
  })
  return { repoPath, worktreePath, workspaceId: workspace.id, taskId: task.id, agentId: agent.id, runId: agentRun.id }
}

describe('collectTaskWorktree', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll((): void => {
    for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
  })

  it('removes the tree, keeps the branch, nulls the path, records the event', async (): Promise<void> => {
    const fixture = await seed()

    const result = await collectTaskWorktree(fixture.taskId, 'operator')

    expect(result.ok).toBe(true)
    expect(existsSync(fixture.worktreePath)).toBe(false)
    expect(
      execFileSync('git', ['branch', '--list', BRANCH], { cwd: fixture.repoPath }).toString(),
    ).toContain(BRANCH)
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).worktreePath,
    ).toBeNull()
    const events = await prisma.executionEvent.findMany({
      where: { taskId: fixture.taskId, type: 'task_worktree_collected' },
    })
    expect(events[0]?.payload).toEqual({ path: fixture.worktreePath, reason: 'operator', branch: BRANCH })
    expect(events[0]?.actor).toBe('human')
  })

  it('aged collection is attributed to the system', async (): Promise<void> => {
    const fixture = await seed()

    const result = await collectTaskWorktree(fixture.taskId, 'aged')

    expect(result.ok).toBe(true)
    const events = await prisma.executionEvent.findMany({
      where: { taskId: fixture.taskId, type: 'task_worktree_collected' },
    })
    expect(events[0]?.payload).toEqual({ path: fixture.worktreePath, reason: 'aged', branch: BRANCH })
    expect(events[0]?.actor).toBe('system')
  })

  it('a tree already gone on disk still collects (prune path)', async (): Promise<void> => {
    const fixture = await seed()
    rmSync(fixture.worktreePath, { recursive: true, force: true })

    const result = await collectTaskWorktree(fixture.taskId, 'operator')

    expect(result.ok).toBe(true)
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).worktreePath,
    ).toBeNull()
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.repoPath }).toString()
    expect(list).not.toContain(fixture.worktreePath)
  })

  it('refuses a running task', async (): Promise<void> => {
    const fixture = await seed({ taskStatus: 'running' })

    const result = await collectTaskWorktree(fixture.taskId, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({ kind: 'task_not_terminal', taskId: fixture.taskId, status: 'running' })
    expect(refusalText(result.error)).toBe(
      `task ${fixture.taskId} is running; only a done, failed or cancelled task's worktree can be collected`,
    )
    expect(existsSync(fixture.worktreePath)).toBe(true)
  })

  it('refuses while a run is alive', async (): Promise<void> => {
    const fixture = await seed({ runStatus: 'working', runPid: process.pid })

    const result = await collectTaskWorktree(fixture.taskId, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({ kind: 'run_still_alive', taskId: fixture.taskId, runId: fixture.runId })
    expect(existsSync(fixture.worktreePath)).toBe(true)
  })

  it('refuses when no run carries a path', async (): Promise<void> => {
    const fixture = await seed({ withWorktreePath: false })

    const result = await collectTaskWorktree(fixture.taskId, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({ kind: 'nothing_to_collect', taskId: fixture.taskId })
  })

  // M23 B2 fix round 1, Important 1: the aged pass and the operator button are exactly the pair
  // of callers that can name the same terminal task at once. Before the fix the row lock released
  // after the check, so both callers saw the same non-null path and the loser's `gitIn` threw out
  // of a `Promise<Result<…>>` contract with no catch above it -- an unhandled rejection, not a
  // refusal. The lock now outlives the git call and the `worktreePath` write, so the loser wakes
  // up to a run with no path left at all: an ordinary `nothing_to_collect`.
  it('two concurrent calls: exactly one collects, the other finds nothing left', async (): Promise<void> => {
    const fixture = await seed()

    const [a, b] = await Promise.all([
      collectTaskWorktree(fixture.taskId, 'aged'),
      collectTaskWorktree(fixture.taskId, 'operator'),
    ])

    const results = [a, b]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const refused = results.find((r) => !r.ok)
    if (refused === undefined || refused.ok) throw new Error('unreachable')
    expect(refused.error).toEqual({ kind: 'nothing_to_collect', taskId: fixture.taskId })

    expect(existsSync(fixture.worktreePath)).toBe(false)
    expect(
      await prisma.executionEvent.count({ where: { taskId: fixture.taskId, type: 'task_worktree_collected' } }),
    ).toBe(1)
  })

  // With the "disk decides" rule (see `collect.ts`), a directory that exists but is not a
  // worktree of this repo at all still reaches `git worktree remove --force`, which fails on it
  // ("is not a working tree") -- asserted on the refusal kind, not git's exact wording, which is
  // not this test's contract to pin.
  it('a git failure refuses worktree_remove_failed, leaving the row and the log untouched', async (): Promise<void> => {
    const fixture = await seed()
    const strayDir = mkdtempSync(join(tmpdir(), 'aiteamos-collect-stray-'))
    await prisma.agentRun.update({ where: { id: fixture.runId }, data: { worktreePath: strayDir } })

    try {
      const result = await collectTaskWorktree(fixture.taskId, 'operator')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.kind).toBe('worktree_remove_failed')
      expect(
        (await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).worktreePath,
      ).toBe(strayDir)
      expect(
        await prisma.executionEvent.count({ where: { taskId: fixture.taskId, type: 'task_worktree_collected' } }),
      ).toBe(0)
    } finally {
      rmSync(strayDir, { recursive: true, force: true })
    }
  })

  it('terminalTimestamp is the latest terminal event', async (): Promise<void> => {
    const fixture = await seed()

    const first = await terminalTimestamp(fixture.taskId)
    expect(first).not.toBeNull()

    await appendEvent({
      type: 'task.failed',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId,
      agentId: fixture.agentId,
      runId: fixture.runId,
      actor: 'system',
      payload: { reason: 'a later failure' },
    })
    const failedRow = await prisma.executionEvent.findFirstOrThrow({
      where: { taskId: fixture.taskId, type: 'task_failed' },
    })

    const latest = await terminalTimestamp(fixture.taskId)
    expect(latest).not.toBeNull()
    expect(latest?.getTime()).toBe(failedRow.ts.getTime())
  })
})
