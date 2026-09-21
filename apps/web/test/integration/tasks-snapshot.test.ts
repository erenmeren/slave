import { prisma } from '@slave-of-ai/db/client'
import { adoptRunbook, syncRunbooks } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTasksSnapshot } from '../../src/server/tasks.js'
import { GET as tasksGET } from '../../src/app/api/w/[workspaceId]/tasks/route.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/tasks-snapshot-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', personId: (await prisma.person.create({ data: { name: 'Alex' } })).id } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

describe('buildTasksSnapshot', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  // Fix round 1, Important 2: a stage is a key in the column and a TITLE on the page. The drawer's
  // chip printed the key, which is the one thing `docs/ia.md` rule 3 forbids, so the snapshot that
  // already reads the workspace resolves it against the adopted runbook.
  it('carries each task stage with the adopted runbook\'s own title for it, and null for a stage nothing lists', async (): Promise<void> => {
    await syncRunbooks()
    await adoptRunbook(fixture.workspaceId, 'security-review')
    await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Model it', description: 'x', status: 'ready', maxAttempts: 3, stage: 'threat-model' },
    })
    await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Something else', description: 'x', status: 'ready', maxAttempts: 3, stage: 'shipit' },
    })
    await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Hand made', description: 'x', status: 'ready', maxAttempts: 3 },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const byTitle = new Map((snapshot?.tasks ?? []).map((task) => [task.title, task] as const))

    expect(byTitle.get('Model it')?.stage).toBe('threat-model')
    expect(byTitle.get('Model it')?.stageTitle).toBe('Threat model')
    // A stage the adopted runbook does not list has no title to show -- the panel says so in words
    // rather than falling back to the key.
    expect(byTitle.get('Something else')?.stageTitle).toBeNull()
    expect(byTitle.get('Hand made')?.stage).toBeNull()
    expect(byTitle.get('Hand made')?.stageTitle).toBeNull()
  })

  it('names who a waiting run is waiting on, and leaves an ordinary pause alone (M36 t3)', async (): Promise<void> => {
    const maya = await prisma.slave.create({ data: { teamId: (await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })).id, role: 'product', personId: (await prisma.person.create({ data: { name: 'Maya' } })).id } })
    const task = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Add the thing',
        description: 'x',
        status: 'waiting',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: fixture.slaveId, status: 'paused', pauseReason: 'waiting_for_answer', pausedAtStep: 3 },
    })
    const humanPause = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: fixture.slaveId, status: 'paused', pauseReason: 'human', pausedAtStep: 1 },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: fixture.slaveId,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientSlaveId: maya.id,
        threadId: 'thread-1',
        kind: 'question',
        body: 'Which queue?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const runs = snapshot?.tasks[0]?.runs ?? []

    expect(runs.find((run) => run.id === waitingRun.id)?.waitingFor).toBe('Maya')
    expect(runs.find((run) => run.id === humanPause.id)?.waitingFor).toBeNull()
  })

  it('returns every task with its runs newest-first and checkpoint summaries', async (): Promise<void> => {
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Add the thing',
        description: 'x',
        status: 'blocked',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const olderRun = await prisma.slaveRun.create({
      data: {
        taskId: seeded.id,
        slaveId: fixture.slaveId,
        status: 'failed',
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        terminalAt: new Date('2026-08-01T01:00:00.000Z'),
        endedAt: new Date('2026-08-01T01:00:00.000Z'),
      },
    })
    const newerRun = await prisma.slaveRun.create({
      data: {
        taskId: seeded.id,
        slaveId: fixture.slaveId,
        status: 'paused',
        startedAt: new Date('2026-08-02T00:00:00.000Z'),
        pausedAtStep: 3,
      },
    })
    await prisma.checkpoint.create({
      data: {
        runId: newerRun.id,
        sessionId: 'session-abc',
        worktreePath: '/tmp/tasks-snapshot-fixture/.slaveofai/worktrees/T-abcdef12',
        pauseFlagPath: '/tmp/tasks-snapshot-fixture/.slaveofai/runs/pause.flag',
        settingsPath: '/tmp/tasks-snapshot-fixture/.slaveofai/runs/settings.json',
        hookPath: '/tmp/tasks-snapshot-fixture/scripts/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        dirtyFiles: ['src/index.ts', 'src/other.ts'],
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === seeded.id)

    expect(task?.runs[0]?.checkpoint?.pausedAtStep).toBe(3)
    expect(task?.runs[0]?.checkpoint?.dirtyFileCount).toBe(2)
    expect(task?.runs.map((r) => r.id)).toEqual([newerRun.id, olderRun.id])
    // No denials on this checkpoint -- an absent field the panel does not render (`toEqual([])`,
    // not an omitted key: `TaskRunSummary.checkpoint.deniedDuringPause` is not optional).
    expect(task?.runs[0]?.checkpoint?.deniedDuringPause).toEqual([])
  })

  it("maps a checkpoint's denied tool-use ids to a null-summary fallback (M18 Task 7)", async (): Promise<void> => {
    // `run.tool_call` event payloads carry only `{ name, summary }` -- no `tool_use_id`
    // (`packages/domain/src/events/schema.ts`) -- so there is no field to join `deniedToolUseIds`
    // against. This is the measured, permanent shape, not a placeholder pending a future join.
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Paused with denials',
        description: 'x',
        status: 'blocked',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const run = await prisma.slaveRun.create({
      data: { taskId: seeded.id, slaveId: fixture.slaveId, status: 'paused', pausedAtStep: 2 },
    })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 'session-denied',
        worktreePath: '/tmp/tasks-snapshot-fixture/.slaveofai/worktrees/T-denied123',
        pauseFlagPath: '/tmp/tasks-snapshot-fixture/.slaveofai/runs/pause.flag',
        settingsPath: '/tmp/tasks-snapshot-fixture/.slaveofai/runs/settings.json',
        hookPath: '/tmp/tasks-snapshot-fixture/scripts/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        dirtyFiles: [],
        deniedToolUseIds: ['toolu_01DEF', 'toolu_01GHI'],
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === seeded.id)

    expect(task?.runs[0]?.checkpoint?.deniedDuringPause).toEqual([
      { id: 'toolu_01DEF', summary: null },
      { id: 'toolu_01GHI', summary: null },
    ])
  })

  it("keeps a run's unknown cost unknown rather than reporting it as $0.00", async (): Promise<void> => {
    // M12 Task 9 / ruling R3. The comment this replaces said `$0.00` was chosen here "rather than
    // widening this DTO to a tri-state" -- widening it is exactly what spec Decision 6 asks for,
    // and the panel now renders the unknown mark the Roster already uses.
    const seeded = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Unmeasured work',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.slaveRun.create({
      data: { taskId: seeded.id, slaveId: fixture.slaveId, status: 'succeeded', costUsd: null },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: seeded.id,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        costUsd: 0.42,
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    const task = snapshot?.tasks.find((t) => t.id === seeded.id)

    expect(task?.runs.map((r) => r.costUsd)).toEqual([null, 0.42])
  })

  it('names the live run slave while work is in flight, and the implementer once it is finished', async (): Promise<void> => {
    // A run is linked to its worker through `SlaveRun.slaveId`, and that is what happened -- so it
    // outranks `Task.assigneeId` (written since H2), which says who HOLDS the task. Deriving the
    // name from the LIVE run alone left every finished task reading nobody, which is not what the
    // board knows: somebody did that work, and the row said nobody had.

    const runningTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Live task',
        description: 'x',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const liveRun = await prisma.slaveRun.create({
      data: { taskId: runningTask.id, slaveId: fixture.slaveId, status: 'working' },
    })
    await prisma.task.update({ where: { id: runningTask.id }, data: { activeRunId: liveRun.id } })

    const doneTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Finished task',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: doneTask.id,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)

    expect(snapshot?.tasks.find((t) => t.id === runningTask.id)?.assigneeName).toBe('Alex')
    expect(snapshot?.tasks.find((t) => t.id === doneTask.id)?.assigneeName).toBe('Alex')
  })

  it('names nobody for a task nobody has run and nobody holds', async (): Promise<void> => {
    // The one case the board should say nobody: a task with no run behind it whose role no seat on
    // the project holds. H2 made this the exception rather than the rule -- a planned task arrives
    // with `assigneeId` already on it -- and a hand-made task like this one still has nobody.
    const queued = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Waiting its turn',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    expect(snapshot?.tasks.find((t) => t.id === queued.id)?.assigneeName).toBeNull()
  })

  it('names the seat a queued task was ASSIGNED to, with no run behind it at all (H2)', async (): Promise<void> => {
    // The whole point of H2: planning wrote `assigneeId` when it created the task, so the card names
    // the person the moment the board appears rather than waiting for a run to start.
    const queued = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Waiting its turn',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
        assigneeId: fixture.slaveId,
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    expect(snapshot?.tasks.find((t) => t.id === queued.id)?.assigneeName).toBe('Alex')
  })

  it('lets the run that did the work outrank a stale assignee (H2)', async (): Promise<void> => {
    // The column is a FIRST answer: dispatch may have handed the work to a different holder of the
    // role, and `startRun` rewrites the column when it does. A projection that preferred the column
    // would name the wrong person for as long as the row disagreed, so the run wins here too.
    const stale = await prisma.slave.create({
      data: {
        teamId: (await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })).id,
        role: 'backend',
        personId: (await prisma.person.create({ data: { name: 'Nina' } })).id,
      },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Somebody else did it',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
        assigneeId: stale.id,
      },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: fixture.slaveId,
        kind: 'implementation',
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    expect(snapshot?.tasks.find((t) => t.id === task.id)?.assigneeName).toBe('Alex')
  })

  it('credits the IMPLEMENTER of a finished task, not the reviewer who looked at it', async (): Promise<void> => {
    // `implementerOf` (`apps/orchestrator/src/verify.ts`) draws this exact distinction for exactly
    // this reason, and the board must not contradict it: the reviewer caught it, the implementer
    // wrote it, and a card naming the reviewer as the person who did the work is a lie an operator
    // would act on.
    const reviewer = await prisma.slave.create({
      data: {
        teamId: (await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })).id,
        role: 'backend',
        personId: (await prisma.person.create({ data: { name: 'Robin' } })).id,
      },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Reviewed and done',
        description: 'x',
        status: 'done',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: fixture.slaveId,
        kind: 'implementation',
        status: 'succeeded',
        startedAt: new Date('2026-01-01T10:00:00Z'),
        terminalAt: new Date('2026-01-01T10:30:00Z'),
        endedAt: new Date('2026-01-01T10:30:00Z'),
      },
    })
    // Newer than the implementation, so "the most recent run" would pick the wrong person.
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: reviewer.id,
        kind: 'review',
        status: 'succeeded',
        startedAt: new Date('2026-01-01T11:00:00Z'),
        terminalAt: new Date('2026-01-01T11:10:00Z'),
        endedAt: new Date('2026-01-01T11:10:00Z'),
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)
    expect(snapshot?.tasks.find((t) => t.id === task.id)?.assigneeName).toBe('Alex')
  })

  it('carries the goal version each task was derived from, beside the version the project is on', async (): Promise<void> => {
    // M40 §6: both numbers come from one reading, because the **stale** badge is a comparison
    // between them and two readings could disagree about which goal the board is behind.
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { goal: 'ship checkout', goalVersion: 2 } })
    const planned = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Wire up the form',
        description: 'x',
        status: 'ready',
        requiredRole: 'frontend',
        maxAttempts: 3,
        goalVersion: 1,
      },
    })
    const handMade = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Chase the vendor',
        description: 'x',
        status: 'backlog',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })

    const snapshot = await buildTasksSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.goalVersion).toBe(2)
    expect(snapshot?.tasks.find((task) => task.id === planned.id)?.goalVersion).toBe(1)
    // A hand-made task was derived from no requirement at all, so it is never behind one.
    expect(snapshot?.tasks.find((task) => task.id === handMade.id)?.goalVersion).toBeNull()
  })

  it('returns null for an unknown workspace', async (): Promise<void> => {
    expect(await buildTasksSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('the route serves the snapshot and 404s an unknown workspace', async (): Promise<void> => {
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Add the thing',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })

    const ok = await tasksGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).tasks.length).toBeGreaterThan(0)

    const missing = await tasksGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
    })
    expect(missing.status).toBe(404)
  })

  // Review finding (M23 B4 fix round 1, Important 2): `TaskBoardItem.collectable` and
  // `TaskRunSummary.worktreePath` had no DB-backed coverage -- every existing test hand-sets the
  // literal. These three prove the real query: `SlaveRun.worktreePath` (not `Checkpoint.worktreePath`,
  // a different column on a different row) is what `collectable` and the run summary read.
  describe('collectable (M23 B4)', () => {
    it('is true for a done task whose run still carries a worktree path', async (): Promise<void> => {
      const seeded = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Finished with a tree still on disk',
          description: 'x',
          status: 'done',
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
      await prisma.slaveRun.create({
        data: {
          taskId: seeded.id,
          slaveId: fixture.slaveId,
          status: 'succeeded',
          worktreePath: '/r/.slaveofai/worktrees/T-collectable',
        },
      })

      const snapshot = await buildTasksSnapshot(fixture.workspaceId)
      const task = snapshot?.tasks.find((t) => t.id === seeded.id)

      expect(task?.collectable).toBe(true)
      expect(task?.runs[0]?.worktreePath).toBe('/r/.slaveofai/worktrees/T-collectable')
    })

    it('is false once that same worktree path is nulled (already collected)', async (): Promise<void> => {
      const seeded = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Finished and already collected',
          description: 'x',
          status: 'done',
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
      await prisma.slaveRun.create({
        data: { taskId: seeded.id, slaveId: fixture.slaveId, status: 'succeeded', worktreePath: null },
      })

      const snapshot = await buildTasksSnapshot(fixture.workspaceId)
      const task = snapshot?.tasks.find((t) => t.id === seeded.id)

      expect(task?.collectable).toBe(false)
      expect(task?.runs[0]?.worktreePath).toBeNull()
    })

    it('is false for a running task even though its run carries a worktree path', async (): Promise<void> => {
      const seeded = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Still running',
          description: 'x',
          status: 'running',
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
      await prisma.slaveRun.create({
        data: {
          taskId: seeded.id,
          slaveId: fixture.slaveId,
          status: 'working',
          worktreePath: '/r/.slaveofai/worktrees/T-still-running',
        },
      })

      const snapshot = await buildTasksSnapshot(fixture.workspaceId)
      const task = snapshot?.tasks.find((t) => t.id === seeded.id)

      expect(task?.collectable).toBe(false)
    })
  })
})
