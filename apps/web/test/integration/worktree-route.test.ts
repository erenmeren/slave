import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DELETE as collectWorktreeDELETE } from '../../src/app/api/w/[workspaceId]/tasks/[taskId]/worktree/route.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

const BRANCH = 'aiteamos/T-b4-route'

// Mirrors `packages/control/test/integration/collect.test.ts`'s `makeRepo` -- this route's own
// coverage is the 404/409/200 wiring through `workspaceControlResponse`, but "200" here still
// runs `collectTaskWorktree` for real against a real worktree, not a stub asserting its own script.
function makeRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-web-worktree-route-'))
  run('git', ['init', '-q', '-b', 'main'], repoPath)
  run('git', ['config', 'user.name', 'Fixture'], repoPath)
  run('git', ['config', 'user.email', 'fixture@example.com'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], repoPath)
  run('git', ['commit', '-q', '-m', 'initial'], repoPath)

  const aiteamosRoot = join(repoPath, '.aiteamos')
  mkdirSync(aiteamosRoot, { recursive: true })
  writeFileSync(join(aiteamosRoot, '.gitignore'), '*\n')

  const worktreePath = join(aiteamosRoot, 'worktrees', 'T-b4')
  run('git', ['worktree', 'add', '-b', BRANCH, worktreePath], repoPath)

  return { repoPath, worktreePath }
}

interface Fixture {
  readonly repoPath: string
  readonly worktreePath: string
  readonly workspaceId: string
  readonly taskId: string
  readonly runId: string
}

const repos: string[] = []

async function seed(taskStatus: 'running' | 'done'): Promise<Fixture> {
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
      status: taskStatus,
      branch: BRANCH,
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const agentRun = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      agentId: agent.id,
      status: taskStatus === 'done' ? 'succeeded' : 'working',
      worktreePath,
    },
  })
  return { repoPath, worktreePath, workspaceId: workspace.id, taskId: task.id, runId: agentRun.id }
}

describe('DELETE /api/w/[workspaceId]/tasks/[taskId]/worktree', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll((): void => {
    for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
  })

  it('404s a workspace that does not exist', async (): Promise<void> => {
    const response = await collectWorktreeDELETE(new Request('http://x', { method: 'DELETE' }), {
      params: Promise.resolve({ workspaceId: 'no-such-workspace', taskId: 'no-such-task' }),
    })
    expect(response.status).toBe(404)
  })

  it('409s a task that is not terminal yet, with the refusal text', async (): Promise<void> => {
    const fixture = await seed('running')

    const response = await collectWorktreeDELETE(new Request('http://x', { method: 'DELETE' }), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId, taskId: fixture.taskId }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('worktree can be collected')
    // The worktree is untouched -- a refused request removes nothing.
    expect(existsSync(fixture.worktreePath)).toBe(true)
  })

  it('200s a terminal task, removing the worktree and nulling the run column', async (): Promise<void> => {
    const fixture = await seed('done')

    const response = await collectWorktreeDELETE(new Request('http://x', { method: 'DELETE' }), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId, taskId: fixture.taskId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(existsSync(fixture.worktreePath)).toBe(false)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).worktreePath).toBeNull()
  })
})
