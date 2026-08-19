import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { taskId as brandTaskId } from '@ai-team-os/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { advance, runVerify } from '../../src/verify.js'
import { provisionWorktree } from '../../src/worktree.js'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-verify-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Fixture {
  readonly repoPath: string
  readonly worktreePath: string
  readonly artifactDir: string
  readonly workspaceId: string
  readonly taskId: string
  readonly runId: string
}

const repos: string[] = []

async function seed(): Promise<Fixture> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
      branch: 'aiteamos/TASK-001-x',
    },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'succeeded', terminalAt: new Date() },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

  const worktree = await provisionWorktree({
    repoPath,
    baseBranch: 'main',
    taskKey: 'TASK-001',
    slug: 'x',
    setupCommands: [],
  })

  return {
    repoPath,
    worktreePath: worktree.path,
    artifactDir: join(repoPath, '.aiteamos', 'artifacts', task.id),
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
  }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

describe('verify and advance', () => {
  let fixture: Fixture
  let base: { taskId: ReturnType<typeof brandTaskId>; worktreePath: string; artifactDir: string; timeoutMs: number }

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    base = {
      taskId: brandTaskId(fixture.taskId),
      worktreePath: fixture.worktreePath,
      artifactDir: fixture.artifactDir,
      timeoutMs: 10_000,
    }
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  const task = async () => prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })

  it('refuses to pass a task whose verify list is empty', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: [] })

    // The behaviour §8 exists to protect. "Nothing failed" is not "it passed": a workspace that
    // configured no verify commands has proved nothing, and reading that as success is how work
    // reaches `done` without anyone or anything having looked at it.
    expect(result.passed).toBe(false)

    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    expect((await task()).status).not.toBe('done')
    // And it is distinguishable from an ordinary rework -- this is a misconfiguration, not a
    // failing test.
    expect(await eventTypesFor(fixture.workspaceId)).toContain('guardrail.tripped')
  })

  it('runs the commands in order and stops at the first failure', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['touch A', 'exit 1', 'touch B'] })

    expect(result.passed).toBe(false)
    expect(result.failedCommand).toBe('exit 1')
    expect(result.exitCode).toBe(1)
    expect(existsSync(join(fixture.worktreePath, 'A'))).toBe(true)
    // Continuing past a failure produces a second, misleading result from a command that should
    // never have run -- and here it would be the one reported to the next agent.
    expect(existsSync(join(fixture.worktreePath, 'B'))).toBe(false)
  })

  it('attaches the failure output to the next run through lastRejectionReason', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['echo BOOM >&2; exit 1'] })

    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    const t = await task()
    expect(t.status).toBe('rework')
    // This field is the agent-facing channel: `buildPrompt` puts it in front of the next run as the
    // thing to fix first. Verify output is exactly what it is for.
    expect(t.lastRejectionReason).toContain('BOOM')
  })

  it('moves the task to done with its branch when every command passes', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })

    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    const t = await task()
    expect(t.status).toBe('done')
    expect(t.branch).toBe('aiteamos/TASK-001-x')
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.done')
  })

  it('moves the task to failed on the attempt that reaches the cap, not one after', async (): Promise<void> => {
    // Seeded `maxAttempts` is 5, so this failure is the fifth attempt. Starting from 5 -- which is
    // what the plan's version of this test did -- leaves `>=` and `>` indistinguishable, because
    // the incremented value clears both. The boundary is the whole point of a cap.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: 4 } })

    const result = await runVerify({ ...base, commands: ['false'] })
    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    const t = await task()
    expect(t.attempt).toBe(5)
    expect(t.status).toBe('failed')
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.failed')
  })

  it('sends the task back for rework on the attempt before the cap', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: 3 } })

    const result = await runVerify({ ...base, commands: ['false'] })
    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    // The other side of the same boundary: one attempt short of the cap must still get a turn, or
    // every task silently gets one fewer attempt than its workspace configured.
    const t = await task()
    expect(t.attempt).toBe(4)
    expect(t.status).toBe('rework')
  })

  it('persists each command with its exit code and a readable log', async (): Promise<void> => {
    await runVerify({ ...base, commands: ['echo first', 'echo second >&2; exit 2'] })

    // Spec §8: "each command's exit code and captured output is persisted as an Artifact. Without
    // it, the reason a task failed is lost, and M4/M5 have nothing to show."
    const artifacts = await prisma.artifact.findMany({ where: { taskId: fixture.taskId } })
    expect(artifacts).toHaveLength(2)
    const logs = artifacts.map((a) => readFileSync(a.path, 'utf8'))
    expect(logs.join('\n')).toContain('first')
    expect(logs.join('\n')).toContain('second')
  })

  it('writes its artifacts outside the worktree, leaving it clean', async (): Promise<void> => {
    await runVerify({ ...base, commands: ['echo noisy'] })

    // The worktree is what the agent commits from. A log file written into it is content the next
    // run would either commit or trip over, and Task 13 already had to move the run's settings and
    // pause flag out for the same reason.
    expect(git(['status', '--porcelain'], fixture.worktreePath)).toBe('')
    const artifacts = await prisma.artifact.findMany({ where: { taskId: fixture.taskId } })
    for (const artifact of artifacts) {
      expect(artifact.path.startsWith(fixture.worktreePath)).toBe(false)
      expect(existsSync(artifact.path)).toBe(true)
    }
  })

  it('reports a command that hangs as a failure naming the timeout', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['sleep 30'], timeoutMs: 300 })

    // A verify command that never returns must not stall whatever is driving verify, and must not
    // be reported as a command that exited non-zero -- the operator's fix for a hang is not the
    // same as their fix for a failing test.
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/timed out/i)
  })

  it('passes a command that prints far more than a pipe buffer holds', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['seq 1 400000'] })

    // `execFile`'s 1 MiB default kills the child and reports the kill as the command's failure,
    // which for a chatty-but-passing `npm test` would move a finished task to rework. Measured
    // against provisioning in Task 11; the same trap, one module over.
    expect(result.passed).toBe(true)
  })

  it('clears the finished run from the task on every terminal transition', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })

    await advance({ taskId: base.taskId, result, branch: 'aiteamos/TASK-001-x' })

    // `activeRunId` points at the run currently working the task (Task 13 sets it). A task left
    // pointing at a finished run reads as busy to anything that consults it.
    expect((await task()).activeRunId).toBeNull()
  })

  it('refuses to finish a task on a branch that is not the one it was worked on', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })

    // `Task.branch` has two writers: the tick sets it at provisioning, this sets it on done. They
    // agree today and nothing enforces it. The branch is what a human merges, so advancing a task
    // to `done` pointing somewhere else is how work gets merged from a branch nobody looked at.
    await expect(
      advance({ taskId: base.taskId, result, branch: 'aiteamos/SOMETHING-ELSE' }),
    ).rejects.toThrow(/branch/)

    expect((await task()).status).not.toBe('done')
  })
})
