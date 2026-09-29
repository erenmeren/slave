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
import { abandonGoal, confirmGoalMerge, goalDeliveries, latestVerifications, retryGoal } from '../../src/goalDelivery.js'
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

      // Said once: a second confirm is idempotent (final wave I1) -- the same commit, nothing more written.
      expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: tip } })
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

  it('confirms a version the goal pass already recorded as merged, without a second event', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1, { status: 'accepted' })
    git(['merge', '-q', '--no-ff', '--no-edit', v1.branch], f.repoPath)
    const tip = git(['rev-parse', 'main'], f.repoPath)
    // The goal pass saw the branch contained and recorded it before the person got to confirm.
    await prisma.executionEvent.create({
      data: {
        workspaceId: f.workspaceId,
        type: 'workspace_goal_merged',
        actor: 'human',
        payload: { version: 1, branch: v1.branch, into: 'main', commit: tip, by: 'human' },
      },
    })
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { mergedAt: new Date() } })
    // The person commits on after the merge; the confirm answers with the commit that was recorded.
    writeFileSync(join(f.repoPath, 'later.txt'), 'later\n')
    git(['add', '-A'], f.repoPath)
    git(['commit', '-q', '-m', 'later'], f.repoPath)

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: tip } })
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

/** Conductor Plan 4b: a verification run of `deliveryId` by the fixture's seat, and its verdict rows. */
async function seedVerification(
  f: Fixture,
  deliveryId: string,
  round: number,
  items: readonly { readonly key: string; readonly status: 'pass' | 'fail' | 'unverifiable' }[],
): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: { slaveId: f.slaveId, kind: 'verification', goalDeliveryId: deliveryId, status: 'succeeded', terminalAt: new Date() },
  })
  for (const item of items) {
    await prisma.verificationResult.create({
      data: { workspaceId: f.workspaceId, goalDeliveryId: deliveryId, goalVersion: 1, round, runId: run.id, key: item.key, status: item.status, check: 'c', output: 'o', reason: '' },
    })
  }
  return run.id
}

/**
 * Final wave I2: an accepted version records the commit its verification passed on
 * (`verifiedCommit`); a person's hand merge is confirmed only for exactly that commit.
 */
describe('confirmGoalMerge (a verified version)', () => {
  async function verifiedAndFailed(f: Fixture): Promise<{ readonly id: string; readonly branch: string; readonly verified: string }> {
    const v1 = await seedDelivery(f, 1, { status: 'accepted', mergeError: 'CONFLICT (content): a.txt' })
    const verified = git(['rev-parse', v1.branch], f.repoPath)
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { verifiedCommit: verified } })
    return { ...v1, verified }
  }

  it('refuses a hand merge of a branch that moved after verification, naming the verified commit', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await verifiedAndFailed(f)
    git(['checkout', '-q', v1.branch], f.repoPath)
    writeFileSync(join(f.repoPath, 'unverified.txt'), 'nobody checked this\n')
    git(['add', '-A'], f.repoPath)
    git(['commit', '-q', '-m', 'after acceptance'], f.repoPath)
    git(['checkout', '-q', 'main'], f.repoPath)
    const tip = git(['rev-parse', v1.branch], f.repoPath)
    git(['merge', '-q', '--no-ff', '--no-edit', v1.branch], f.repoPath)

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({
      ok: false,
      error: { kind: 'goal_tip_not_verified', goalVersion: 1, branch: v1.branch, verifiedCommit: v1.verified, tip },
    })
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).mergedAt).toBeNull()
    expect(await eventsOf(f.workspaceId, 'workspace_goal_merged')).toHaveLength(0)
  })

  it('confirms a hand merge of exactly the verified commit', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await verifiedAndFailed(f)
    git(['merge', '-q', '--no-ff', '--no-edit', v1.verified], f.repoPath)
    const merged = git(['rev-parse', 'main'], f.repoPath)

    expect(await confirmGoalMerge(f.workspaceId, 1)).toEqual({ ok: true, value: { commit: merged } })
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).mergedAt).not.toBeNull()
  })
})

describe('goalDeliveries (Conductor Plan 4b)', () => {
  it('shows the round, why a person is needed, and the latest verification', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await seedVerification(f, v1.id, 1, [
      { key: 'R1', status: 'fail' },
      { key: 'R2', status: 'fail' },
    ])
    await seedVerification(f, v1.id, 2, [
      { key: 'R1', status: 'pass' },
      { key: 'R2', status: 'fail' },
      { key: 'R3', status: 'unverifiable' },
    ])
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'needs_human', round: 2, needsHumanReason: 'the cap' } })

    const all = await goalDeliveries(f.workspaceId)

    expect(all.ok && all.value[0]).toMatchObject({
      status: 'needs_human',
      round: 2,
      needsHumanReason: 'the cap',
      latestVerification: { round: 2, pass: 1, fail: 1, unverifiable: 1, failedKeys: ['R2'] },
    })
  })

  it('has no latest verification before a round has concluded', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)

    expect((await latestVerifications([v1.id])).get(v1.id)).toBeUndefined()
    const all = await goalDeliveries(f.workspaceId)
    expect(all.ok && all.value[0]).toMatchObject({ round: 0, needsHumanReason: null, latestVerification: null })
  })
})

describe('retryGoal', () => {
  it('moves a needs_human version back to integrating with a fresh round window, and says so once', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await prisma.goalDelivery.update({
      where: { id: v1.id },
      data: { status: 'needs_human', round: 3, roundBase: 0, roundRunFailures: 2, needsHumanReason: 'the cap' },
    })

    expect(await retryGoal(f.workspaceId, 1)).toEqual({ ok: true, value: { round: 3 } })

    expect(await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      status: 'integrating',
      round: 3,
      roundBase: 3,
      roundRunFailures: 0,
      needsHumanReason: null,
    })
    const retried = await eventsOf(f.workspaceId, 'workspace_goal_retried')
    expect(retried).toEqual([{ taskId: null, payload: { version: 1, round: 3 }, actor: 'human' }])

    // A second retry finds nothing to retry.
    expect(await retryGoal(f.workspaceId, 1)).toEqual({ ok: false, error: { kind: 'goal_not_needs_human', goalVersion: 1, status: 'integrating' } })
    expect(await eventsOf(f.workspaceId, 'workspace_goal_retried')).toHaveLength(1)
  })

  it('refuses a version that does not need a person, and one that does not exist', async (): Promise<void> => {
    const f = await seedWorkspace()
    await seedDelivery(f, 1)
    await seedDelivery(f, 2, { status: 'accepted' })

    expect(await retryGoal(f.workspaceId, 1)).toEqual({ ok: false, error: { kind: 'goal_not_needs_human', goalVersion: 1, status: 'integrating' } })
    expect(await retryGoal(f.workspaceId, 2)).toEqual({ ok: false, error: { kind: 'goal_not_needs_human', goalVersion: 2, status: 'accepted' } })
    expect(await retryGoal(f.workspaceId, 9)).toEqual({ ok: false, error: { kind: 'goal_version_not_found', workspaceId: f.workspaceId, goalVersion: 9 } })
    expect(await eventsOf(f.workspaceId, 'workspace_goal_retried')).toHaveLength(0)
  })

  it('stamps a retry whose event a crash already wrote, without a second event', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'needs_human', round: 2 } })
    await prisma.executionEvent.create({
      data: { workspaceId: f.workspaceId, type: 'workspace_goal_retried', actor: 'human', payload: { version: 1, round: 2 } },
    })

    expect(await retryGoal(f.workspaceId, 1)).toEqual({ ok: true, value: { round: 2 } })
    expect(await eventsOf(f.workspaceId, 'workspace_goal_retried')).toHaveLength(1)
  })
})

describe('abandonGoal (Conductor Plan 4b)', () => {
  // Final wave I1: a running verification is stopped by the abandonment, not a refusal of it.
  it('abandons a version a verification run holds, clearing the claim and stopping the run', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await seedPackageTask(f, 1, 'a', { status: 'done', integratedAt: new Date() })
    const run = await prisma.slaveRun.create({ data: { slaveId: f.slaveId, kind: 'verification', goalDeliveryId: v1.id, status: 'working' } })
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'verifying', round: 1, activeRunId: run.id } })

    expect(await abandonGoal(f.workspaceId, 1)).toEqual({ ok: true, value: { cancelled: [], stoppedRun: run.id } })
    expect(await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ status: 'abandoned', activeRunId: null })
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('stopped')
    expect(await eventsOf(f.workspaceId, 'run_stopped')).toHaveLength(1)
  })

  it('abandons a version that needs a person', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    const rework = await seedPackageTask(f, 1, 'a', { status: 'rework' })
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'needs_human', round: 3 } })

    expect(await abandonGoal(f.workspaceId, 1)).toEqual({ ok: true, value: { cancelled: [rework.taskId] } })
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('abandoned')
  })
})

/**
 * Conductor Plan 4b, fix round 1 (I1): a person who acts on a goal version answers the Supervisor's
 * `goal_needs_human` escalation for it by doing so -- the pending decision is resolved, and only
 * that version's (a sibling version's escalation stays in front of the person).
 */
describe('the goal_needs_human escalation is resolved by the person\'s act', () => {
  async function pendingEscalation(f: Fixture, subjectId: string): Promise<string> {
    const row = await prisma.supervisorDecision.create({
      data: {
        workspaceId: f.workspaceId,
        situationKind: 'goal_needs_human',
        subjectId,
        situation: {},
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'escalate_to_human', summary: 'Goal needs a person' },
        rationale: 'the loop stopped',
        tier: 'escalated',
        status: 'pending',
        decidedBy: 'rules',
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      },
    })
    return row.id
  }
  const statusOf = async (id: string): Promise<string> => (await prisma.supervisorDecision.findUniqueOrThrow({ where: { id } })).status

  it('retry-goal resolves this version\'s escalation and leaves another version\'s', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'needs_human', round: 2, needsHumanReason: 'the cap' } })
    const mine = await pendingEscalation(f, `${f.workspaceId}:v1:r2`)
    const sibling = await pendingEscalation(f, `${f.workspaceId}:v10:r1`)

    expect((await retryGoal(f.workspaceId, 1)).ok).toBe(true)

    expect(await statusOf(mine)).toBe('rejected')
    expect(await statusOf(sibling)).toBe('pending')
    expect(await eventsOf(f.workspaceId, 'supervisor_resolved')).toHaveLength(1)
  })

  it('abandon-goal resolves it', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1)
    await prisma.goalDelivery.update({ where: { id: v1.id }, data: { status: 'needs_human', round: 3 } })
    const mine = await pendingEscalation(f, `${f.workspaceId}:v1:r3`)

    expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
    expect(await statusOf(mine)).toBe('rejected')
  })

  it('confirm-goal-merge resolves the failed-merge escalation', async (): Promise<void> => {
    const f = await seedWorkspace()
    const v1 = await seedDelivery(f, 1, { status: 'accepted', mergeError: 'CONFLICT (content): a.txt' })
    const mine = await pendingEscalation(f, `${f.workspaceId}:v1:merge`)
    git(['merge', '-q', '--no-ff', '--no-edit', v1.branch], f.repoPath)

    expect((await confirmGoalMerge(f.workspaceId, 1)).ok).toBe(true)
    expect(await statusOf(mine)).toBe('rejected')
  })

  it('a refused act resolves nothing', async (): Promise<void> => {
    const f = await seedWorkspace()
    await seedDelivery(f, 1)
    const mine = await pendingEscalation(f, `${f.workspaceId}:v1:r1`)

    expect((await retryGoal(f.workspaceId, 1)).ok).toBe(false)
    expect(await statusOf(mine)).toBe('pending')
  })
})
