import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { taskId as brandTaskId } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { advance, runVerify } from '../../src/verify.js'
import { provisionWorktree } from '../../src/worktree.js'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-verify-'))
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
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
      branch: 'slaveofai/TASK-001-x',
    },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id, status: 'succeeded', terminalAt: new Date() },
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
    artifactDir: join(repoPath, '.slaveofai', 'artifacts', task.id),
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
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

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

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
    // never have run -- and here it would be the one reported to the next slave.
    expect(existsSync(join(fixture.worktreePath, 'B'))).toBe(false)
  })

  it('attaches the failure output to the next run through lastRejectionReason', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['echo BOOM >&2; exit 1'] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    const t = await task()
    expect(t.status).toBe('rework')
    // This field is the slave-facing channel: `buildPrompt` puts it in front of the next run as the
    // thing to fix first. Verify output is exactly what it is for.
    expect(t.lastRejectionReason).toContain('BOOM')
  })

  it('moves the task to reviewing with its branch when every command passes', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // The pipeline flip (M8a): a green verify no longer finishes the task on its own -- it hands
    // the task to review (Task 5), which is the only path left to `done` (Task 7's merge pass).
    const t = await task()
    expect(t.status).toBe('reviewing')
    expect(t.branch).toBe('slaveofai/TASK-001-x')
    const types = await eventTypesFor(fixture.workspaceId)
    expect(types).toContain('task.verify_passed')
    expect(types).not.toContain('task.done')
  })

  it('moves the task to failed on the attempt that reaches the cap, not one after', async (): Promise<void> => {
    // Seeded `maxAttempts` is 5, so this failure is the fifth attempt. Starting from 5 -- which is
    // what the plan's version of this test did -- leaves `>=` and `>` indistinguishable, because
    // the incremented value clears both. The boundary is the whole point of a cap.
    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: 4 } })

    const result = await runVerify({ ...base, commands: ['false'] })
    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    const t = await task()
    expect(t.attempt).toBe(5)
    expect(t.status).toBe('failed')
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.failed')
  })

  it('sends the task back for rework on the attempt before the cap', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: 3 } })

    const result = await runVerify({ ...base, commands: ['false'] })
    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

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

    // The worktree is what the slave commits from. A log file written into it is content the next
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

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // `activeRunId` points at the run currently working the task (Task 13 sets it). A task left
    // pointing at a finished run reads as busy to anything that consults it.
    expect((await task()).activeRunId).toBeNull()
  })

  it("keeps each attempt's artifacts instead of overwriting the last one", async (): Promise<void> => {
    writeFileSync(join(fixture.worktreePath, 'n'), 'ONE\n')
    await runVerify({ ...base, commands: ['cat n; exit 1'] })

    await prisma.task.update({ where: { id: fixture.taskId }, data: { attempt: 1 } })
    writeFileSync(join(fixture.worktreePath, 'n'), 'TWO\n')
    await runVerify({ ...base, commands: ['cat n; exit 1'] })

    // The command list is the same every attempt, so a path built from the command alone is the
    // same path every attempt. Two rows pointing at one file means the older row reports the newer
    // attempt's output -- worse than losing it, because M4/M5 render it as the earlier attempt with
    // nothing to signal otherwise. Spec §8 exists to stop exactly this.
    const artifacts = await prisma.artifact.findMany({ where: { taskId: fixture.taskId } })
    expect(artifacts).toHaveLength(2)
    expect(new Set(artifacts.map((a) => a.path)).size).toBe(2)
    const contents = artifacts.map((a) => readFileSync(a.path, 'utf8')).join('|')
    expect(contents).toContain('ONE')
    expect(contents).toContain('TWO')
  })

  it('does not tell the next slave to fix the workspace configuration', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: [] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // `lastRejectionReason` reaches the next run's prompt as the thing to fix first. An unconfigured
    // verify list is not something an slave caused or can reach, and Task 13 was corrected for
    // exactly this: nothing but what a verify command actually printed belongs in this field.
    expect((await task()).lastRejectionReason).toBeNull()
  })

  it('does not spend an attempt, or keep scheduling, on a workspace that cannot verify', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: [] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // Every task in this workspace will hit the same wall, so charging each of them maxAttempts
    // full slave runs before failing is the worst available behaviour -- §13.1 says so in as many
    // words about the equivalent hook misconfiguration, and the remedy there is the same: stop
    // scheduling and make a human look.
    const t = await task()
    expect(t.attempt).toBe(0)
    expect(t.status).not.toBe('rework')
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(workspace.haltedReason).not.toBeNull()
  })

  it('is harmless when it runs twice for the same result', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['false'] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })
    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // "Exactly once per terminal run" at the call site is a much harder property than "harmless if
    // called twice" here, and a second call otherwise double-counts the attempt -- enough to push a
    // task over its own cap -- and writes a duplicate terminal event into an append-only log.
    const t = await task()
    expect(t.attempt).toBe(1)
    const types = await eventTypesFor(fixture.workspaceId)
    expect(types.filter((e) => e === 'task.rework')).toHaveLength(1)
  })

  it('refuses to finish a task that is no longer being worked on', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'cancelled' } })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // A stale verify result arriving after an operator cancelled the task must not resurrect it to
    // `done` and announce it -- the same class of thing the branch check exists for, one field over.
    expect((await task()).status).toBe('cancelled')
    expect(await eventTypesFor(fixture.workspaceId)).not.toContain('task.done')
  })

  it('reports a verify that could not run at all, rather than throwing into the caller', async (): Promise<void> => {
    const result = await runVerify({ ...base, worktreePath: join(fixture.repoPath, 'no-such-dir'), commands: ['true'] })

    // §13's rule is that no failure is silent. An unrunnable verify -- a missing worktree, an
    // unwritable artifact directory -- previously threw after `task.verifying` had been emitted,
    // leaving the task `running` with no terminal event and nothing to reconcile it.
    expect(result.kind).toBe('could_not_run')
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/could not run/i)
  })

  it('does not charge an attempt for a verify that could not run', async (): Promise<void> => {
    const result = await runVerify({ ...base, worktreePath: join(fixture.repoPath, 'no-such-dir'), commands: ['true'] })

    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    // The slave did not cause a missing worktree and cannot fix one. Charging the attempt spends
    // the task's budget on the orchestrator's own problem.
    expect((await task()).attempt).toBe(0)
  })

  it('emits the transition sequence spec §8 names, in order', async (): Promise<void> => {
    const pass = await runVerify({ ...base, commands: ['true'] })
    await advance({ taskId: base.taskId, result: pass, branch: 'slaveofai/TASK-001-x' })

    // `toContain` on a single value cannot see a missing event, a reordered one, or a duplicated
    // one -- the whole catalogue this task produces could be deleted and every other assertion here
    // would still pass. `task.done` no longer belongs to this sequence (M8a): it moves to the merge
    // pass, which this call never reaches.
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['task.verifying', 'task.verify_passed'])
  })

  it('emits the failing transition sequence, with the command and its exit code', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['exit 3'] })
    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    expect(await eventTypesFor(fixture.workspaceId)).toEqual([
      'task.verifying',
      'task.verify_failed',
      'task.rework',
    ])
    const failed = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'task_verify_failed' },
    })
    expect(failed.payload).toMatchObject({ command: 'exit 3', exitCode: 3 })
  })

  it('reports a timed-out command with no exit code rather than a made-up one', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['sleep 30'], timeoutMs: 300 })
    await advance({ taskId: base.taskId, result, branch: 'slaveofai/TASK-001-x' })

    const failed = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, type: 'task_verify_failed' },
    })
    // A killed command has no exit code. The sentinel has to be distinguishable from 0, which is
    // the one value that would read as success.
    expect((failed.payload as { exitCode: number }).exitCode).toBe(-1)
  })

  it('writes a log an operator can read: the command, how it ended, and what it printed', async (): Promise<void> => {
    await runVerify({ ...base, commands: ['echo hello; exit 4'] })

    const artifact = await prisma.artifact.findFirstOrThrow({ where: { taskId: fixture.taskId } })
    const log = readFileSync(artifact.path, 'utf8')
    expect(log).toContain('exit 4')
    expect(log).toContain('echo hello; exit 4')
    expect(log).toContain('hello')
    expect(artifact.kind).toBe('verify')
  })

  it('keeps two commands that read alike in separate logs', async (): Promise<void> => {
    const shared = 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await runVerify({ ...base, commands: [`${shared} one`, `${shared} two`] })

    // The slug is truncated, so two long commands sharing a prefix produce the same slug. The index
    // prefix is what keeps them apart -- untested until now, which is how it would have been
    // "simplified" away.
    const artifacts = await prisma.artifact.findMany({ where: { taskId: fixture.taskId } })
    expect(new Set(artifacts.map((a) => a.path)).size).toBe(2)
  })

  it('clears the old rejection when the task finally passes', async (): Promise<void> => {
    const failure = await runVerify({ ...base, commands: ['echo OLDFAILURE; exit 1'] })
    await advance({ taskId: base.taskId, result: failure, branch: 'slaveofai/TASK-001-x' })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running' } })

    const pass = await runVerify({ ...base, commands: ['true'] })
    await advance({ taskId: base.taskId, result: pass, branch: 'slaveofai/TASK-001-x' })

    expect((await task()).lastRejectionReason).toBeNull()
  })

  it('refuses to finish a task on a branch that is not the one it was worked on', async (): Promise<void> => {
    const result = await runVerify({ ...base, commands: ['true'] })

    // `Task.branch` has two writers: the tick sets it at provisioning, this sets it on done. They
    // agree today and nothing enforces it. The branch is what a human merges, so advancing a task
    // to `done` pointing somewhere else is how work gets merged from a branch nobody looked at.
    await expect(
      advance({ taskId: base.taskId, result, branch: 'slaveofai/SOMETHING-ELSE' }),
    ).rejects.toThrow(/branch/)

    expect((await task()).status).not.toBe('done')
  })
})
