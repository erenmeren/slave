import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, describe, expect, it } from 'vitest'
import { releaseWorker, setLifecycle } from '../../src/lifecycle.js'

/** Every row this file makes carries one of these two prefixes, so the teardown can find its own
 *  work in a database every other integration file in this run also writes to. `M50 Lifecycle` and
 *  not `M50 Security` (fix round 1, Minor 6): `supervisor.test.ts` names ITS template
 *  `M50 Security …`, and a prefix two files share is a teardown that reaches into the other one. */
const WORKSPACE_PREFIX = 'M50 Lifecycle'
const TEMPLATE_PREFIX = 'M50 Lifecycle Security'

const BRANCH = 'slaveofai/T-m50-lifecycle'

/** The repositories {@link makeRepo} left on disk, removed once at the end of the file. */
const repos: string[] = []

/**
 * A real repository with one real worktree on its own branch -- `collect.test.ts`'s own fixture,
 * trimmed to what this file needs. The `worktreesCollected: 1` case has to prove the count against
 * a tree `git worktree remove` can actually remove, which a made-up path cannot do.
 */
function makeRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-lifecycle-'))
  const run = (...args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: repoPath, encoding: 'utf8' })
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Fixture')
  run('config', 'user.email', 'fixture@example.com')
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'initial')
  mkdirSync(join(repoPath, '.slaveofai'), { recursive: true })
  writeFileSync(join(repoPath, '.slaveofai', '.gitignore'), '*\n')
  const worktreePath = join(repoPath, '.slaveofai', 'worktrees', 'T-m50')
  run('worktree', 'add', '-b', BRANCH, worktreePath)
  repos.push(repoPath)
  return { repoPath, worktreePath }
}

/**
 * A project with one task, one template, one ephemeral worker hired for that task, and one run on
 * it. Every knob is a fact one of the cases below is about; the defaults are the ordinary
 * "assignment finished, worker idle" shape.
 */
async function seedEngagement(opts: {
  readonly taskStatus: 'done' | 'running'
  readonly lifecycle?: 'project' | 'ephemeral'
  readonly runStatus?: 'succeeded' | 'working'
  readonly worktreePath?: string | null
  /** A REAL repository and a real worktree on disk, so `collectTaskWorktree` can succeed and the
   *  release can count it. Overrides {@link worktreePath}. */
  readonly realWorktree?: boolean
}): Promise<{ workspaceId: string; slaveId: string; taskId: string; runId: string; worktreePath: string | null }> {
  const stamp = `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  const repo = opts.realWorktree === true ? makeRepo() : null
  const worktreePath =
    repo !== null ? repo.worktreePath : opts.worktreePath === undefined ? null : opts.worktreePath
  const workspace = await prisma.workspace.create({
    // `verifyCommands`/`setupCommands` have no column default -- an omitted one is a null
    // constraint violation, not an empty list (`capability.test.ts`'s own workspace seed).
    data: {
      name: `${WORKSPACE_PREFIX} ${stamp}`,
      repoPath: repo?.repoPath ?? '/tmp/m50-lifecycle',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Specialists' } })
  const template = await prisma.slaveTemplate.create({
    data: { name: `${TEMPLATE_PREFIX} ${stamp}`, role: 'security', capabilityKeys: ['security.application'] },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add authentication',
      description: 'the one assignment',
      status: opts.taskStatus,
      maxAttempts: 3,
      requiredRole: 'security',
      ...(repo === null ? {} : { branch: BRANCH }),
    },
  })
  const slave = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: 'Robin',
      role: 'Security Reviewer',
      runtimeRoles: ['security'],
      capabilities: ['security.application'],
      selectionRationale: 'brought in for the authentication path',
      hiredFromTemplateId: template.id,
      lifecycle: opts.lifecycle ?? 'ephemeral',
      engagementTaskId: task.id,
    },
  })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: slave.id,
      kind: 'implementation',
      status: opts.runStatus ?? 'succeeded',
      worktreePath,
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id, runId: run.id, worktreePath }
}

// FK order, scoped to this file's own name prefixes (`memory.test.ts`'s idiom). This file does NOT
// truncate: `capability.test.ts` may truncate the same tables, and a file that only deletes what it
// made can sit anywhere in the run order without emptying a table under the next one.
afterAll(async () => {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true },
  })
  const workspaceIds = workspaces.map((row) => row.id)
  await prisma.executionEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: { in: workspaceIds } } } } })
  await prisma.task.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.slave.deleteMany({ where: { team: { workspaceId: { in: workspaceIds } } } })
  await prisma.team.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  await prisma.slaveTemplate.deleteMany({ where: { name: { startsWith: TEMPLATE_PREFIX } } })
  for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
})

describe('releaseWorker', () => {
  it('empties the runtime roles, stamps the release, and keeps every row the worker wrote', async () => {
    const { workspaceId, slaveId, taskId, runId } = await seedEngagement({ taskStatus: 'done' })

    const result = await releaseWorker(slaveId, 'the engagement is over')
    expect(result.ok).toBe(true)

    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.runtimeRoles).toEqual([])
    expect(after.releasedAt).not.toBeNull()
    expect(after.releaseReason).toBe('the engagement is over')
    // R5: nothing else moved.
    expect(after.lifecycle).toBe('ephemeral')
    expect(after.engagementTaskId).toBe(taskId)
    expect(after.capabilities).toEqual(['security.application'])
    expect(after.selectionRationale).not.toBeNull()
    expect(after.hiredFromTemplateId).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { slaveId } })).toBe(1)
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toBeDefined()

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'slave_released' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ slaveId, reason: 'the engagement is over' })
  })

  it('refuses a worker that is not ephemeral', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', lifecycle: 'project' })
    const result = await releaseWorker(slaveId, 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('not_ephemeral')
  })

  it('refuses a second release, and writes nothing the second time', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releaseWorker(slaveId, 'first')).ok).toBe(true)
    const second = await releaseWorker(slaveId, 'second')
    expect(second.ok).toBe(false)
    expect(second.ok ? null : second.error.kind).toBe('already_released')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.releaseReason).toBe('first')
  })

  it('refuses while a run is live, and leaves the roles alone', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await releaseWorker(slaveId, 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('live_runs')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.runtimeRoles).toEqual(['security'])
  })

  it('refuses a worker that is gone', async () => {
    const result = await releaseWorker('00000000-0000-0000-0000-000000000000', 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('slave_not_found')
  })

  it('counts only the worktrees it could actually collect, and never throws for one it could not', async () => {
    // The run carries a path that is not a worktree of this repository, so `git worktree remove`
    // refuses and `collectTaskWorktree` returns `worktree_remove_failed`. The release still stands.
    const { slaveId } = await seedEngagement({ taskStatus: 'done', worktreePath: '/nonexistent/m50-gate-tree' })
    const result = await releaseWorker(slaveId, 'the engagement is over')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.worktreesCollected : -1).toBe(0)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })).releasedAt).not.toBeNull()
  })

  // Fix round 1, Minor 5: the count is a MEASUREMENT, so one case has to see it reach 1 against a
  // tree git can actually remove -- otherwise every assertion in this file is about zero.
  it('counts the worktree it removed, and nulls the path the run was holding', async () => {
    const { slaveId, runId, worktreePath } = await seedEngagement({ taskStatus: 'done', realWorktree: true })
    expect(worktreePath).not.toBeNull()
    expect(existsSync(worktreePath ?? '')).toBe(true)

    const result = await releaseWorker(slaveId, 'the engagement is over')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.worktreesCollected : -1).toBe(1)
    expect(existsSync(worktreePath ?? '')).toBe(false)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).worktreePath).toBeNull()
  })

  // Fix round 1, Important 1: `slave.released`'s payload schema is `z.string().min(1)`, so a blank
  // reason written to the column would commit the release and then have the EVENT refused. The
  // sentence is normalised before the transaction, and no refusal kind was added for it (D4).
  it('records a blank reason as "released" rather than writing a release nothing can log', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    const result = await releaseWorker(slaveId, '   ')
    expect(result.ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })).releaseReason).toBe('released')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'slave_released' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ slaveId, reason: 'released' })
  })
})

describe('setLifecycle', () => {
  it('moves ephemeral to project, clearing the engagement and the release with it', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releaseWorker(slaveId, 'over')).ok).toBe(true)

    const result = await setLifecycle(slaveId, 'project')
    expect(result.ok).toBe(true)
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.lifecycle).toBe('project')
    expect(after.engagementTaskId).toBeNull()
    expect(after.releasedAt).toBeNull()
    expect(after.releaseReason).toBeNull()
    // R4: nothing is restored. The person sets the roles.
    expect(after.runtimeRoles).toEqual([])

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'org_changed' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ entity: 'slave', field: 'lifecycle', from: 'ephemeral', to: 'project' })
  })

  it('refuses permanent for a worker with no roster row', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done' })
    const result = await setLifecycle(slaveId, 'permanent')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('not_in_roster')
  })

  // Fix round 1, Minor 1: the no-move is decided BEFORE the roster check. `companySlaveId` is
  // `SetNull`, so a permanent worker whose roster row was deleted is still permanent -- and asking
  // for the lifecycle it already has is a no-op, never a refusal about a change nobody made.
  it('is a no-op, not not_in_roster, for a permanent worker with no roster row asked to stay permanent', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    await prisma.slave.update({ where: { id: slaveId }, data: { lifecycle: 'permanent' } })
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })

    const result = await setLifecycle(slaveId, 'permanent')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value : null).toEqual({ from: 'permanent', to: 'permanent' })
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })).lifecycle).toBe('permanent')
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(before)
  })

  it('refuses while a run is live', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await setLifecycle(slaveId, 'project')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('live_runs')
  })

  it('writes no event when the lifecycle did not move', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })
    expect((await setLifecycle(slaveId, 'ephemeral')).ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(before)
  })
})
