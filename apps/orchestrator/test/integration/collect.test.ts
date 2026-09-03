import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKTREE_TTL_MS } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { collectWorktrees } from '../../src/collect.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * A real repository with `.aiteamos/.gitignore` already in place -- the same shape
 * `packages/control/test/integration/collect.test.ts` builds for `collectTaskWorktree` itself.
 * One repo is shared by every task seeded against a workspace (mirrors production: one
 * `Workspace.repoPath`, many tasks each with their own worktree under it), so this suite proves
 * the pass picking the right candidate out of several real worktrees in the same repo.
 */
function makeRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-orch-collect-'))
  run('git', ['init', '-q', '-b', 'main'], repoPath)
  run('git', ['config', 'user.name', 'Fixture'], repoPath)
  run('git', ['config', 'user.email', 'fixture@example.com'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], repoPath)
  run('git', ['commit', '-q', '-m', 'initial'], repoPath)

  const aiteamosRoot = join(repoPath, '.aiteamos')
  mkdirSync(aiteamosRoot, { recursive: true })
  writeFileSync(join(aiteamosRoot, '.gitignore'), '*\n')

  return repoPath
}

function addWorktree(repoPath: string, n: number): string {
  const branch = `aiteamos/T-collect-${n}`
  const worktreePath = join(repoPath, '.aiteamos', 'worktrees', `T-collect-${n}`)
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
  overrides: { readonly withTerminalEvent?: boolean } = {},
): Promise<TaskFixture> {
  const worktreePath = addWorktree(repoPath, n)
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: `Add thing ${n}`,
      description: 'make it work',
      status: 'done' as never,
      branch: `aiteamos/T-collect-${n}`,
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const agentRun = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'succeeded' as never, pid: null, worktreePath },
  })
  if (overrides.withTerminalEvent !== false) {
    await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId: task.id,
      agentId: agent.id,
      runId: agentRun.id,
      actor: 'agent',
      payload: { branch: `aiteamos/T-collect-${n}` },
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
})
