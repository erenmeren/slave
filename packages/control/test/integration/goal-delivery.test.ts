/**
 * Conductor Plan 4a, Task 6: the person's verbs on a goal version -- see its delivery, abandon it
 * (plan D10, controller ruling P1), confirm a merge they made by hand (plan D9). Real git in a temp
 * repository; task states are seeded directly with Prisma.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { abandonGoal, confirmGoalMerge, goalDeliveries } from '../../src/goalDelivery.js'
import { recordRunEvidence } from '../../src/evidence.js'

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-goal-delivery-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly slaveId: string
}

async function seedWorkspace(): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: { name: 'Goal Delivery', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted' },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Alex' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: person.id } })
  return { workspaceId: workspace.id, repoPath, slaveId: slave.id }
}

/** A delivery row with its integration branch cut from `main`, carrying one commit of its own. */
async function seedDelivery(
  f: Fixture,
  goalVersion: number,
  data: { readonly status?: 'integrating' | 'accepted' | 'abandoned'; readonly mergedAt?: Date; readonly mergeError?: string } = {},
): Promise<{ readonly id: string; readonly branch: string }> {
  const branch = `slaveofai/goal-v${String(goalVersion)}-${f.workspaceId.slice(0, 8)}`
  const baseCommit = git(['rev-parse', 'main'], f.repoPath)
  git(['branch', branch, 'main'], f.repoPath)
  git(['checkout', '-q', branch], f.repoPath)
  writeFileSync(join(f.repoPath, `v${String(goalVersion)}.txt`), 'the goal\n')
  git(['add', '-A'], f.repoPath)
  git(['commit', '-q', '-m', `goal v${String(goalVersion)}`], f.repoPath)
  git(['checkout', '-q', 'main'], f.repoPath)
  const row = await prisma.goalDelivery.create({
    data: {
      workspaceId: f.workspaceId,
      goalVersion,
      integrationBranch: branch,
      baseCommit,
      status: data.status ?? 'integrating',
      acceptedAt: data.status === 'accepted' ? new Date() : null,
      mergedAt: data.mergedAt ?? null,
      mergeError: data.mergeError ?? null,
    },
  })
  return { id: row.id, branch }
}

async function seedPackageTask(
  f: Fixture,
  goalVersion: number,
  key: string,
  data: {
    readonly status: 'ready' | 'rework' | 'blocked' | 'backlog' | 'done' | 'running' | 'merging' | 'reviewing'
    readonly integratedAt?: Date
    readonly withRun?: boolean
  },
): Promise<{ readonly taskId: string; readonly runId: string | null }> {
  const pkg = await prisma.workPackage.create({
    data: { workspaceId: f.workspaceId, goalVersion, key, title: key, requirementKeys: ['R1'], ownedPaths: [`${key}/**`], interface: '', templateId: 'tpl' },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: f.workspaceId,
      title: `The ${key} package`,
      description: 'x',
      status: data.status,
      requiredRole: 'backend',
      maxAttempts: 5,
      workPackageId: pkg.id,
      goalVersion,
      integratedAt: data.integratedAt ?? null,
    },
  })
  if (data.withRun !== true) return { taskId: task.id, runId: null }
  const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: f.slaveId, status: 'succeeded', terminalAt: new Date() } })
  await recordRunEvidence(run.id)
  return { taskId: task.id, runId: run.id }
}

async function eventsOf(workspaceId: string, type: string): Promise<readonly { readonly taskId: string | null; readonly payload: unknown; readonly actor: string }[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId, type: type as never }, orderBy: { seq: 'asc' } })
  return rows.map((row) => ({ taskId: row.taskId, payload: row.payload, actor: row.actor }))
}

afterAll(async (): Promise<void> => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  await prisma.$disconnect()
}, 30_000)

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "EvidenceRecord", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

describe('goalDeliveries', () => {
  it('lists versions ascending with their packages, and filters by version', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v2 = await seedDelivery(f, 2)
    const v1 = await seedDelivery(f, 1, { status: 'accepted' })
    const csv = await seedPackageTask(f, 1, 'csv', { status: 'done', integratedAt: new Date() })
    const json = await seedPackageTask(f, 2, 'json', { status: 'ready' })

    const all = await goalDeliveries(f.workspaceId)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.map((view) => view.goalVersion)).toEqual([1, 2])
    expect(all.value[0]).toMatchObject({
      goalVersion: 1,
      status: 'accepted',
      integrationBranch: v1.branch,
      mergedAt: null,
      mergeError: null,
      packages: [{ taskId: csv.taskId, key: 'csv', status: 'done', integrated: true }],
    })
    expect(all.value[0]?.acceptedAt).toEqual(expect.any(String))
    expect(all.value[1]).toMatchObject({
      goalVersion: 2,
      status: 'integrating',
      integrationBranch: v2.branch,
      acceptedAt: null,
      packages: [{ taskId: json.taskId, key: 'json', status: 'ready', integrated: false }],
    })

    const one = await goalDeliveries(f.workspaceId, 2)
    expect(one.ok && one.value.map((view) => view.goalVersion)).toEqual([2])
  })

  it('refuses a workspace that does not exist', async (): Promise<void> => {
    const missing = '00000000-0000-0000-0000-000000000000'
    expect(await goalDeliveries(missing)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: missing } })
  })
})

describe('abandonGoal', () => {
  it('cancels every unfinished package task in one go, leaves finished work, and frees the next version', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await seedDelivery(f, 2)
    const ready = await seedPackageTask(f, 1, 'a', { status: 'ready' })
    const rework = await seedPackageTask(f, 1, 'b', { status: 'rework' })
    const blocked = await seedPackageTask(f, 1, 'c', { status: 'blocked' })
    const done = await seedPackageTask(f, 1, 'd', { status: 'done', integratedAt: new Date() })
    const other = await seedPackageTask(f, 2, 'e', { status: 'ready' })

    const result = await abandonGoal(f.workspaceId, 1)

    expect(result.ok).toBe(true)
    const cancelled = [ready.taskId, rework.taskId, blocked.taskId]
    if (result.ok) expect([...result.value.cancelled].sort()).toEqual([...cancelled].sort())
    for (const id of cancelled) {
      expect((await prisma.task.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.taskId } })).status).toBe('done')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: other.taskId } })).status).toBe('ready')
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('abandoned')

    const taskEvents = await eventsOf(f.workspaceId, 'task_cancelled')
    expect(taskEvents.map((event) => event.taskId).sort()).toEqual([...cancelled].sort())
    expect(taskEvents.every((event) => event.actor === 'human')).toBe(true)
    const abandoned = await eventsOf(f.workspaceId, 'workspace_goal_abandoned')
    expect(abandoned).toHaveLength(1)
    const payload = abandoned[0]?.payload as { version: number; cancelled: string[] }
    expect(payload.version).toBe(1)
    expect([...payload.cancelled].sort()).toEqual([...cancelled].sort())

    // Plan D6, the conductor's own wait query: nothing earlier than v2 is still on its way.
    const earlierOpen = await prisma.goalDelivery.count({
      where: { workspaceId: f.workspaceId, goalVersion: { lt: 2 }, status: { not: 'abandoned' }, mergedAt: null },
    })
    expect(earlierOpen).toBe(0)
  })

  for (const busy of [
    { label: 'a running task', status: 'running' as const },
    { label: 'a task in review', status: 'reviewing' as const },
    { label: 'a task waiting to merge', status: 'merging' as const },
  ]) {
    it(`is refused while ${busy.label} holds the version, and changes nothing`, async (): Promise<void> => {
      const f = await seedWorkspace()
      const v1 = await seedDelivery(f, 1)
      const ready = await seedPackageTask(f, 1, 'a', { status: 'ready' })
      const held = await seedPackageTask(f, 1, 'b', { status: busy.status })

      const result = await abandonGoal(f.workspaceId, 1)

      expect(result).toEqual({ ok: false, error: { kind: 'goal_version_busy', goalVersion: 1, holder: `task ${held.taskId}` } })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: ready.taskId } })).status).toBe('ready')
      expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('integrating')
      expect(await eventsOf(f.workspaceId, 'task_cancelled')).toHaveLength(0)
      expect(await eventsOf(f.workspaceId, 'workspace_goal_abandoned')).toHaveLength(0)
    })
  }

  it('is refused while a parked task still carries a run', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    const rework = await seedPackageTask(f, 1, 'a', { status: 'rework', withRun: true })
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: rework.taskId } })
    await prisma.task.update({ where: { id: rework.taskId }, data: { activeRunId: run.id } })

    const result = await abandonGoal(f.workspaceId, 1)

    expect(result).toEqual({ ok: false, error: { kind: 'goal_version_busy', goalVersion: 1, holder: `task ${rework.taskId}` } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: rework.taskId } })).status).toBe('rework')
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('integrating')
  })

  it('refuses a version already abandoned or merged, and one that does not exist', async (): Promise<void> => {
    const f = await seedWorkspace()
    await seedDelivery(f, 1, { status: 'abandoned' })
    await seedDelivery(f, 2, { status: 'accepted', mergedAt: new Date() })

    expect(await abandonGoal(f.workspaceId, 1)).toEqual({ ok: false, error: { kind: 'goal_version_closed', goalVersion: 1, status: 'abandoned' } })
    expect(await abandonGoal(f.workspaceId, 2)).toEqual({ ok: false, error: { kind: 'goal_version_closed', goalVersion: 2, status: 'merged' } })
    expect(await abandonGoal(f.workspaceId, 7)).toEqual({
      ok: false,
      error: { kind: 'goal_version_not_found', workspaceId: f.workspaceId, goalVersion: 7 },
    })
  })
})

describe('confirmGoalMerge', () => {
  for (const variant of [
    { label: 'a merge git refused', mergeError: 'CONFLICT (content): a.txt' },
    { label: 'the base-moved wait', mergeError: undefined },
  ]) {
    it(`confirms a hand merge after ${variant.label}: stamped, announced once as the person's, evidence settled`, async (): Promise<void> => {
      const f = await seedWorkspace()
      const v1 = await seedDelivery(f, 1, { status: 'accepted', ...(variant.mergeError === undefined ? {} : { mergeError: variant.mergeError }) })
      const pkg = await seedPackageTask(f, 1, 'a', { status: 'done', integratedAt: new Date(), withRun: true })
      // The person moved main meanwhile, then merged the integration branch by hand.
      writeFileSync(join(f.repoPath, 'mine.txt'), 'mine\n')
      git(['add', '-A'], f.repoPath)
      git(['commit', '-q', '-m', 'the person'], f.repoPath)
      git(['merge', '-q', '--no-ff', '--no-edit', v1.branch], f.repoPath)
      const tip = git(['rev-parse', 'main'], f.repoPath)

      const result = await confirmGoalMerge(f.workspaceId, 1)

      expect(result).toEqual({ ok: true, value: { commit: tip } })
      const row = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })
      expect(row.mergedAt).not.toBeNull()
      expect(row.mergeError).toBeNull()
      const merged = await eventsOf(f.workspaceId, 'workspace_goal_merged')
      expect(merged).toHaveLength(1)
      expect(merged[0]?.actor).toBe('human')
      expect(merged[0]?.payload).toEqual({ version: 1, branch: v1.branch, into: 'main', commit: tip, by: 'human' })
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: pkg.runId ?? '' } })).integrated).toBe(true)

      // Said once: a second confirm is refused as closed, and nothing more is written.
      expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: false, error: { kind: 'goal_version_closed', goalVersion: 1, status: 'merged' } })
      expect(await eventsOf(f.workspaceId, 'workspace_goal_merged')).toHaveLength(1)
    })
  }

  it('stamps a merge whose event a crash already wrote, without a second event', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1, { status: 'accepted' })
    git(['merge', '-q', '--no-ff', '--no-edit', v1.branch], f.repoPath)
    const tip = git(['rev-parse', 'main'], f.repoPath)
    await prisma.executionEvent.create({
      data: {
        workspaceId: f.workspaceId,
        type: 'workspace_goal_merged',
        actor: 'human',
        payload: { version: 1, branch: v1.branch, into: 'main', commit: tip, by: 'human' },
      },
    })

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: tip } })
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).mergedAt).not.toBeNull()
    expect(await eventsOf(f.workspaceId, 'workspace_goal_merged')).toHaveLength(1)
  })

  it('refuses when the integration branch is not in the base branch, and changes nothing', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1, { status: 'accepted', mergeError: 'conflict' })

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({
      ok: false,
      error: { kind: 'goal_not_merged', goalVersion: 1, branch: v1.branch, into: 'main' },
    })
    const row = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })
    expect(row.mergedAt).toBeNull()
    expect(row.mergeError).toBe('conflict')
    expect(await eventsOf(f.workspaceId, 'workspace_goal_merged')).toHaveLength(0)
  })

  it('refuses an integrating version, a merged one, an abandoned one and a missing one', async (): Promise<void> => {
    const f = await seedWorkspace()
    await seedDelivery(f, 1)
    await seedDelivery(f, 2, { status: 'accepted', mergedAt: new Date() })
    await seedDelivery(f, 3, { status: 'abandoned' })

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: false, error: { kind: 'goal_not_accepted', goalVersion: 1, status: 'integrating' } })
    expect(await confirmGoalMerge(f.workspaceId, 2)).toEqual({ ok: false, error: { kind: 'goal_version_closed', goalVersion: 2, status: 'merged' } })
    expect(await confirmGoalMerge(f.workspaceId, 3)).toEqual({ ok: false, error: { kind: 'goal_version_closed', goalVersion: 3, status: 'abandoned' } })
    expect(await confirmGoalMerge(f.workspaceId, 9)).toEqual({
      ok: false,
      error: { kind: 'goal_version_not_found', workspaceId: f.workspaceId, goalVersion: 9 },
    })
  })
})
