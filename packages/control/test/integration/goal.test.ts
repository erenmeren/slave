import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { goalDiff, goalSha256 } from '@slave-of-ai/domain'
import { listGoalVersions, setGoal } from '../../src/goal.js'

// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-goal-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(name = 'Checkout Platform'): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspace: { id: workspace.id } }
}

describe('setGoal', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('sets the goal column and emits exactly one workspace.goal_set event with the goal in the payload', async () => {
    const { workspace } = fixture

    const result = await setGoal(workspace.id, 'Ship the checkout redesign')

    expect(result).toEqual({
      ok: true,
      value: { version: 1, sha256: goalSha256('Ship the checkout redesign') },
    })

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBe('Ship the checkout redesign')
    expect(after.goalVersion).toBe(1)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(1)
    // M40 t2: the payload names the `GoalVersion` row this write created and the content hash of
    // its text -- the two facts that make a goal edit traceable without reading the table.
    expect(events[0]?.payload).toEqual({
      goal: 'Ship the checkout redesign',
      version: 1,
      sha256: goalSha256('Ship the checkout redesign'),
    })
    expect(events[0]?.actor).toBe('human')
  })

  it('stamps the event and the workspace with the principal, when one is given', async () => {
    const { workspace } = fixture
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant-for-this-test' } })

    const result = await setGoal(workspace.id, 'Ship the checkout redesign', { userId: user.id })

    expect(result.ok).toBe(true)

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goalSetByUserId).toBe(user.id)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.userId).toBe(user.id)
  })

  it('leaves goalSetByUserId and the event userId null with no principal', async () => {
    const { workspace } = fixture

    await setGoal(workspace.id, 'Ship the checkout redesign')

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goalSetByUserId).toBeNull()

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events[0]?.userId).toBeNull()
  })

  it('refuses a blank goal, leaving the column untouched and emitting no event', async () => {
    const { workspace } = fixture

    const result = await setGoal(workspace.id, '   ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_goal' })

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBeNull()

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(0)
  })

  it('refuses an unknown workspace', async () => {
    const result = await setGoal('00000000-0000-4000-8000-000000000000', 'Ship it')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'workspace_not_found', workspaceId: '00000000-0000-4000-8000-000000000000' })
    }
  })

  it('succeeds on a workspace that already has a task', async () => {
    const { workspace } = fixture
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Existing task',
        description: 'already on the board',
        maxAttempts: 3,
      },
    })

    const result = await setGoal(workspace.id, 'Ship the checkout redesign')

    expect(result.ok).toBe(true)
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBe('Ship the checkout redesign')
  })

  // M40 §1: a goal version is IMMUTABLE. A second set does not overwrite the first -- it writes
  // version 2 beside it, and the workspace's own columns become a cache of the newest one.
  it('writes a second version beside the first rather than over it, and moves the cache to it', async () => {
    const { workspace } = fixture

    expect(await setGoal(workspace.id, 'Ship the checkout redesign')).toEqual({
      ok: true,
      value: { version: 1, sha256: goalSha256('Ship the checkout redesign') },
    })
    expect(await setGoal(workspace.id, 'Ship the checkout redesign\nand the receipts')).toEqual({
      ok: true,
      value: { version: 2, sha256: goalSha256('Ship the checkout redesign\nand the receipts') },
    })

    const rows = await prisma.goalVersion.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { version: 'asc' },
    })
    expect(rows.map((row) => ({ version: row.version, text: row.text, sha256: row.sha256 }))).toEqual([
      {
        version: 1,
        text: 'Ship the checkout redesign',
        sha256: goalSha256('Ship the checkout redesign'),
      },
      {
        version: 2,
        text: 'Ship the checkout redesign\nand the receipts',
        sha256: goalSha256('Ship the checkout redesign\nand the receipts'),
      },
    ])

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goal).toBe('Ship the checkout redesign\nand the receipts')
    expect(after.goalVersion).toBe(2)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
      orderBy: { seq: 'asc' },
    })
    expect(events.map((event) => event.payload)).toEqual([
      { goal: 'Ship the checkout redesign', version: 1, sha256: goalSha256('Ship the checkout redesign') },
      {
        goal: 'Ship the checkout redesign\nand the receipts',
        version: 2,
        sha256: goalSha256('Ship the checkout redesign\nand the receipts'),
      },
    ])
  })

  it('stamps the version row with the principal too, and leaves it null without one', async () => {
    const { workspace } = fixture
    const user = await prisma.user.create({ data: { username: 'grace', passwordHash: 'irrelevant' } })

    expect((await setGoal(workspace.id, 'Ship it', { userId: user.id })).ok).toBe(true)
    expect((await setGoal(workspace.id, 'Ship it faster')).ok).toBe(true)

    const rows = await prisma.goalVersion.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { version: 'asc' },
      select: { version: true, setByUserId: true },
    })
    expect(rows).toEqual([
      { version: 1, setByUserId: user.id },
      { version: 2, setByUserId: null },
    ])
  })

  // Spec erratum E5. The sha is compared against the CURRENT version's, inside the row lock, and
  // the refusal is returned as a value because nothing was written -- no row, no event, no cache
  // move. Re-saving an unedited goal in the web panel must not manufacture a version, because a
  // version is what the re-plan trigger counts.
  it('refuses goal_unchanged when the text hashes to the current version, writing nothing', async () => {
    const { workspace } = fixture
    expect((await setGoal(workspace.id, 'Ship the checkout redesign')).ok).toBe(true)

    const again = await setGoal(workspace.id, 'Ship the checkout redesign')

    expect(again).toEqual({ ok: false, error: { kind: 'goal_unchanged', workspaceId: workspace.id, version: 1 } })
    expect(await prisma.goalVersion.count({ where: { workspaceId: workspace.id } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { workspaceId: workspace.id, type: 'workspace_goal_set' } }),
    ).toBe(1)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).goalVersion).toBe(1)
  })

  // Only the CURRENT version is compared, not the whole history: going back to an older wording is
  // a real edit, and the re-plan it triggers is the point of the milestone.
  it('accepts a return to an older version\'s text as a new version', async () => {
    const { workspace } = fixture
    expect((await setGoal(workspace.id, 'Ship A')).ok).toBe(true)
    expect((await setGoal(workspace.id, 'Ship B')).ok).toBe(true)

    expect(await setGoal(workspace.id, 'Ship A')).toEqual({ ok: true, value: { version: 3, sha256: goalSha256('Ship A') } })
    expect(await prisma.goalVersion.count({ where: { workspaceId: workspace.id } })).toBe(3)
  })

  /**
   * The row lock, proved by concurrency rather than asserted in a comment. Both calls read
   * `goalVersion` and both write `goalVersion + 1`; without `SELECT ... FOR UPDATE` they read the
   * same 0 and the compound unique `(workspaceId, version)` turns the loser into a thrown Prisma
   * error rather than version 2. Two awaited together must come back {1, 2}, in either order.
   */
  it('serialises two concurrent sets into versions 1 and 2, never a duplicate', async () => {
    const { workspace } = fixture

    const [first, second] = await Promise.all([
      setGoal(workspace.id, 'Ship the checkout redesign'),
      setGoal(workspace.id, 'Ship the receipts rewrite'),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const versions = [first.ok ? first.value.version : -1, second.ok ? second.value.version : -1].sort()
    expect(versions).toEqual([1, 2])

    const rows = await prisma.goalVersion.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { version: 'asc' },
      select: { version: true, text: true },
    })
    expect(rows.map((row) => row.version)).toEqual([1, 2])
    // The workspace's cache is the LAST writer's text and its version -- not a mixture of the two.
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.goalVersion).toBe(2)
    expect(after.goal).toBe(rows[1]?.text)
  })
})

describe('listGoalVersions', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('reads the history newest first, each version diffed against the one before it', async () => {
    const { workspace } = fixture
    const v1 = 'Ship the checkout redesign\nKeep the old flow behind a flag'
    const v2 = 'Ship the checkout redesign\nRetire the old flow'
    expect((await setGoal(workspace.id, v1)).ok).toBe(true)
    expect((await setGoal(workspace.id, v2)).ok).toBe(true)

    const result = await listGoalVersions(workspace.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.map((view) => view.version)).toEqual([2, 1])
    expect(result.value[0]).toMatchObject({
      version: 2,
      text: v2,
      sha256: goalSha256(v2),
      setByUserId: null,
      diff: goalDiff(v1, v2),
    })
    expect(result.value[0]?.diff).toEqual({
      added: ['Retire the old flow'],
      removed: ['Keep the old flow behind a flag'],
    })
    // The oldest version has nothing to be diffed against: v1 IS the requirement's beginning.
    expect(result.value[1]?.diff).toBeNull()
    // `createdAt` is an ISO string, so a web route can serialise the view unchanged.
    expect(result.value[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('carries the user who set each version', async () => {
    const { workspace } = fixture
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant' } })
    expect((await setGoal(workspace.id, 'Ship it', { userId: user.id })).ok).toBe(true)

    const result = await listGoalVersions(workspace.id)
    expect(result.ok && result.value[0]?.setByUserId).toBe(user.id)
  })

  it('returns an empty history for a workspace whose goal was never set', async () => {
    expect(await listGoalVersions(fixture.workspace.id)).toEqual({ ok: true, value: [] })
  })

  it('refuses an unknown workspace rather than answering with an empty history', async () => {
    expect(await listGoalVersions('00000000-0000-4000-8000-000000000000')).toEqual({
      ok: false,
      error: { kind: 'workspace_not_found', workspaceId: '00000000-0000-4000-8000-000000000000' },
    })
  })

  it('never reaches into another project\'s history', async () => {
    const other = await seed('Receipts Platform')
    expect((await setGoal(fixture.workspace.id, 'Ours')).ok).toBe(true)
    expect((await setGoal(other.workspace.id, 'Theirs')).ok).toBe(true)

    const mine = await listGoalVersions(fixture.workspace.id)
    expect(mine.ok && mine.value.map((view) => view.text)).toEqual(['Ours'])
  })
})
