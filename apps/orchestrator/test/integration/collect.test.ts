import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKTREE_TTL_MS } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectWorktrees } from '../../src/collect.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * A real repository with `.slaveofai/.gitignore` already in place -- the same shape
 * `packages/control/test/integration/collect.test.ts` builds for `collectTaskWorktree` itself.
 * One repo is shared by every task seeded against a workspace (mirrors production: one
 * `Workspace.repoPath`, many tasks each with their own worktree under it), so this suite proves
 * the pass picking the right candidate out of several real worktrees in the same repo.
 */
function makeRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-orch-collect-'))
  run('git', ['init', '-q', '-b', 'main'], repoPath)
  run('git', ['config', 'user.name', 'Fixture'], repoPath)
  run('git', ['config', 'user.email', 'fixture@example.com'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], repoPath)
  run('git', ['commit', '-q', '-m', 'initial'], repoPath)

  const slaveofaiRoot = join(repoPath, '.slaveofai')
  mkdirSync(slaveofaiRoot, { recursive: true })
  writeFileSync(join(slaveofaiRoot, '.gitignore'), '*\n')

  return repoPath
}

function addWorktree(repoPath: string, n: number): string {
  const branch = `slaveofai/T-collect-${n}`
  const worktreePath = join(repoPath, '.slaveofai', 'worktrees', `T-collect-${n}`)
  run('git', ['worktree', 'add', '-b', branch, worktreePath], repoPath)
  return worktreePath
}

interface TaskFixture {
  readonly worktreePath: string
  readonly taskId: string
  readonly runId: string
}

const repos: string[] = []

async function seedWorkspace(): Promise<{ workspaceId: string; repoPath: string }> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: { name: `Checkout ${repos.length}`, repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  return { workspaceId: workspace.id, repoPath }
}

async function seedTask(
  workspaceId: string,
  repoPath: string,
  n: number,
  overrides: {
    readonly withTerminalEvent?: boolean
    readonly runStatus?: string
    readonly runPid?: number | null
    /** A path the DB row claims as the worktree without it being a real one from `addWorktree` --
     *  the shape a `worktree_remove_failed` refusal needs (a directory that exists but is not a
     *  worktree of this repo, mirroring the Task 4 fixture's "stray dir"). */
    readonly worktreePath?: string
  } = {},
): Promise<TaskFixture> {
  const worktreePath = overrides.worktreePath ?? addWorktree(repoPath, n)
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: `Add thing ${n}`,
      description: 'make it work',
      status: 'done' as never,
      branch: `slaveofai/T-collect-${n}`,
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const agentRun = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      agentId: agent.id,
      status: (overrides.runStatus ?? 'succeeded') as never,
      pid: overrides.runPid ?? null,
      worktreePath,
    },
  })
  if (overrides.withTerminalEvent !== false) {
    await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId: task.id,
      agentId: agent.id,
      runId: agentRun.id,
      actor: 'agent',
      payload: { branch: `slaveofai/T-collect-${n}` },
    })
  }
  return { worktreePath, taskId: task.id, runId: agentRun.id }
}

/** Ages a task's `task.done` event by rewriting `ts` directly (Step 1's recipe) -- there is no
 *  column to age through Prisma's client API; `terminalTimestamp` reads the event log itself. */
async function ageTerminalEvent(taskId: string, days: number): Promise<void> {
  const row = await prisma.executionEvent.findFirstOrThrow({
    where: { taskId, type: { in: ['task_done', 'task_failed'] } },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  await prisma.$executeRaw`UPDATE "ExecutionEvent" SET ts = now() - (${days} || ' days')::interval WHERE seq = ${row.seq}`
}

describe('collectWorktrees', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll((): void => {
    for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
  })

  it('collects the task aged past the TTL, skips the young one, and a repeat run finds nothing left', async (): Promise<void> => {
    const { workspaceId, repoPath } = await seedWorkspace()
    const old = await seedTask(workspaceId, repoPath, 1)
    const young = await seedTask(workspaceId, repoPath, 2)
    await ageTerminalEvent(old.taskId, 8)
    await ageTerminalEvent(young.taskId, 1)

    const report = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })

    expect(report.collected).toEqual([{ taskId: old.taskId, path: old.worktreePath }])
    expect(report.skipped).toBe(1)
    expect(existsSync(old.worktreePath)).toBe(false)
    expect(existsSync(young.worktreePath)).toBe(true)

    const second = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })
    expect(second.collected).toEqual([])
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: old.runId } })).worktreePath,
    ).toBeNull()
  })

  it('a done task with no terminal event is skipped forever', async (): Promise<void> => {
    const { workspaceId, repoPath } = await seedWorkspace()
    const noEvent = await seedTask(workspaceId, repoPath, 3, { withTerminalEvent: false })

    const report = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })

    expect(report.collected).toEqual([])
    expect(report.skipped).toBe(1)
    expect(existsSync(noEvent.worktreePath)).toBe(true)
  })

  // Fix round 1, Important 1: a refusal used to only bump `skipped` -- an operator watching the
  // log had no way to tell "still alive" apart from "not yet aged". Aged past the TTL and still
  // refused is the case that must reach stderr; not-yet-aged (the other two tests above) must not.
  it('a refusal reaches stderr, naming the task and why', async (): Promise<void> => {
    const { workspaceId, repoPath } = await seedWorkspace()
    const alive = await seedTask(workspaceId, repoPath, 4, { runStatus: 'working', runPid: process.pid })
    await ageTerminalEvent(alive.taskId, 8)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const report = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })

      expect(report.collected).toEqual([])
      expect(report.skipped).toBe(1)
      const lines = stderr.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes(`[collect] task ${alive.taskId}:`) && line.includes('still alive'))).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })

  // Fix round 1, Important 2: `terminalTimestamp` used to sit outside the per-candidate try, so a
  // failure dating one task could throw out of the whole pass. There is no way to force a DB error
  // on one candidate without mocking, so this proves the weaker, directly observable half of the
  // same guarantee: a refusal on one candidate (`worktree_remove_failed`, via a stray directory
  // that exists but is not a worktree of this repo -- the Task 4 fixture) does not stop the pass
  // from reaching and collecting the other one.
  it('a worktree_remove_failed refusal on one candidate does not stop the pass collecting another', async (): Promise<void> => {
    const { workspaceId, repoPath } = await seedWorkspace()
    const strayDir = mkdtempSync(join(tmpdir(), 'slaveofai-orch-collect-stray-'))
    const stray = await seedTask(workspaceId, repoPath, 5, { worktreePath: strayDir })
    const collectable = await seedTask(workspaceId, repoPath, 6)
    await ageTerminalEvent(stray.taskId, 8)
    await ageTerminalEvent(collectable.taskId, 8)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const report = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })

      expect(report.collected).toEqual([{ taskId: collectable.taskId, path: collectable.worktreePath }])
      expect(report.skipped).toBe(1)
      const lines = stderr.mock.calls.map((call) => String(call[0]))
      expect(lines.filter((line) => line.includes(`[collect] task ${stray.taskId}:`))).toHaveLength(1)
    } finally {
      stderr.mockRestore()
      rmSync(strayDir, { recursive: true, force: true })
    }
  })
})
