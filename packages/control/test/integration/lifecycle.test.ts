import { prisma } from '@slave-of-ai/db/client'
import { afterAll, describe, expect, it } from 'vitest'
import { releaseWorker, setLifecycle } from '../../src/lifecycle.js'

/** Every row this file makes carries one of these two prefixes, so the teardown can find its own
 *  work in a database every other integration file in this run also writes to. */
const WORKSPACE_PREFIX = 'm50 lifecycle'
const TEMPLATE_PREFIX = 'M50 Security'

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
}): Promise<{ workspaceId: string; slaveId: string; taskId: string; runId: string }> {
  const stamp = `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  const workspace = await prisma.workspace.create({
    // `verifyCommands`/`setupCommands` have no column default -- an omitted one is a null
    // constraint violation, not an empty list (`capability.test.ts`'s own workspace seed).
    data: {
      name: `${WORKSPACE_PREFIX} ${stamp}`,
      repoPath: '/tmp/m50-lifecycle',
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
      worktreePath: opts.worktreePath === undefined ? null : opts.worktreePath,
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id, runId: run.id }
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
