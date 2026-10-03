/**
 * Human-cards spec H3 (plan A D7): a run paused on an unanswered question past the project's question
 * timeout continues on its own judgement; a halt keeps it waiting and says why; an answer and the
 * timeout in one window produce one resume.
 */
import { answerQuestion } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverAnswers } from '../../src/deliver.js'
import { inboxSection } from '../../src/inbox.js'
import { RESUMED_WITHOUT_ANSWER_NOTE, continueWaitingRuns, questionTimeoutDeps } from '../../src/questionTimeout.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "Task", "WorkPackage", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'
const HOUR = 3_600_000
const T0 = new Date('2026-10-02T08:00:00.000Z')

interface Fixture {
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  readonly questionId: string
}

/** A run parked on a question at T0, with a checkpoint (a resume needs one) and a dead pid. */
async function seed(options: { readonly timeoutMs?: number; readonly haltedReason?: string; readonly workspaceId?: string } = {}): Promise<Fixture> {
  const ws =
    options.workspaceId !== undefined
      ? { id: options.workspaceId }
      : await prisma.workspace.create({
          data: {
            name: `Timeout ${String(Math.random())}`,
            repoPath: '/nonexistent',
            verifyCommands: ['true'],
            setupCommands: [],
            ...(options.timeoutMs === undefined ? {} : { questionTimeoutMs: options.timeoutMs }),
            ...(options.haltedReason === undefined ? {} : { haltedReason: options.haltedReason, haltedAt: T0 }),
          },
        })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: `E ${String(Math.random())}` } })
  const person = await prisma.person.create({ data: { name: `Ivo ${String(Math.random())}` } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: person.id } })
  const task = await prisma.task.create({
    data: { workspaceId: ws.id, title: 'integration', description: 'x', status: 'waiting', requiredRole: 'implementer', maxAttempts: 3, assigneeId: seat.id },
  })
  const run = await prisma.slaveRun.create({
    data: { slaveId: seat.id, taskId: task.id, status: 'paused', pauseReason: 'waiting_for_answer', pausedAt: T0, provider: 'claude_code' },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })
  // Plan A F4: the four required columns the brief's seed missed.
  await prisma.checkpoint.create({
    data: {
      runId: run.id,
      sessionId: 's1',
      worktreePath: '/tmp/w',
      pauseFlagPath: '/tmp/p',
      settingsPath: '/tmp/settings.json',
      hookPath: '/tmp/pause-gate.sh',
      gitAuthorName: 'Ivo',
      gitAuthorEmail: 'ivo@slaveofai.local',
      deniedToolUseIds: [],
      headCommit: 'a'.repeat(40),
      dirtyFiles: [],
    },
  })
  const q = await prisma.slaveMessage.create({
    data: {
      id: `q-${run.id}`,
      threadId: `q-${run.id}`,
      workspaceId: ws.id,
      taskId: task.id,
      slaveId: seat.id,
      senderRunId: run.id,
      recipientRole: 'conductor',
      kind: 'question',
      body: 'May I add a start script to backend/package.json?',
      expectsReply: true,
      actor: 'slave',
      createdAt: T0,
    },
  })
  return { workspaceId: ws.id, runId: run.id, taskId: task.id, questionId: q.id }
}

const runOf = (f: Fixture) => prisma.slaveRun.findUniqueOrThrow({ where: { id: f.runId } })
const questionOf = (f: Fixture) => prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })
const resumeEvents = (f: Fixture) => prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'run_resume_requested' } })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the question timeout (human cards H3)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('does nothing before the timeout', async () => {
    const f = await seed()
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 2 * HOUR - 1000))).toEqual([])
    expect((await questionOf(f)).closedAt).toBeNull()
    expect((await runOf(f)).resumeRequestedAt).toBeNull()
  })

  it('continues the run past the timeout with the spec sentence, and closes the question timed out', async () => {
    const f = await seed()
    const now = new Date(T0.getTime() + 2 * HOUR + 1000)
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([{ runId: f.runId, questionId: f.questionId, reason: 'timed_out' }])
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out', closedBy: 'system', timeoutRefusal: null })
    const run = await runOf(f)
    expect(run.resumeRequestedAt).not.toBeNull()
    expect(run.queuedMessage?.split('\n')[0]).toBe('No answer came in 2 hours. Continue on your safest assumption, and say in your report which assumption you made.')
    expect(run.queuedMessage).toContain('backend/package.json')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })).toBe(1)
    expect(await resumeEvents(f)).toBe(1)
    // Once: a second pass finds the run already continuing.
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([])
    expect(await resumeEvents(f)).toBe(1)
  })

  it("honours the project's own timeout", async () => {
    const f = await seed({ timeoutMs: 15 * 60_000 })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 14 * 60_000))).toEqual([])
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 16 * 60_000))).toHaveLength(1)
  })

  it("keeps a halted project's run waiting and says why, leaving the question open, then continues it once the halt is cleared", async () => {
    const f = await seed({ haltedReason: 'emergency_stop' })
    const now = new Date(T0.getTime() + 3 * HOUR)
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([])
    expect((await runOf(f)).resumeRequestedAt).toBeNull()
    // The close follows the resume (task 6 ruling): a refused resume leaves the question open.
    const waiting = await questionOf(f)
    expect(waiting.closedAt).toBeNull()
    expect(waiting.timeoutRefusal).toContain('halted')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })).toBe(0)
    // A second refused pass writes nothing new.
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([])
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { haltedReason: null, haltedAt: null } })
    expect(await continueWaitingRuns(f.workspaceId, now)).toHaveLength(1)
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out', timeoutRefusal: null })
    expect(await resumeEvents(f)).toBe(1)
  })

  it('continues a run whose question a person closed without an answer, at once, with the close note', async () => {
    const f = await seed()
    const note = 'A person closed your question. Proceed without the start script.'
    await prisma.slaveMessage.update({ where: { id: f.questionId }, data: { closedAt: T0, closedReason: 'dismissed', closedBy: 'operator', closedNote: note } })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 60_000))).toEqual([{ runId: f.runId, questionId: f.questionId, reason: 'dismissed' }])
    expect((await runOf(f)).queuedMessage).toBe(note)
    expect(await questionOf(f)).toMatchObject({ closedReason: 'dismissed' })
  })

  it('leaves an answered question to deliverAnswers', async () => {
    const f = await seed()
    await answerQuestion(f.questionId, { body: 'Yes, core-domain adds it.', answeredBy: 'web operator' })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    expect((await questionOf(f)).closedReason).toBe('answered')
    expect((await runOf(f)).resumeRequestedAt).toBeNull()
  })

  it('writes one resume when the timeout and an answer meet: the timeout first, the answer left undelivered (spec §4)', async () => {
    const f = await seed()
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toHaveLength(1)
    // The answer lands after the timeout closed the question and wrote the run's intent.
    expect((await answerQuestion(f.questionId, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    expect(await deliverAnswers(f.workspaceId)).toEqual([])
    const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })
    expect(answer.deliveredAt).toBeNull()
    expect((await runOf(f)).queuedMessage?.startsWith('No answer came in')).toBe(true)
    expect(await resumeEvents(f)).toBe(1)
  })

  it('writes one resume when the answer goes first: the timeout pass then finds the run continuing (spec §4)', async () => {
    const f = await seed()
    await answerQuestion(f.questionId, { body: 'Yes.', answeredBy: 'web operator' })
    expect(await deliverAnswers(f.workspaceId)).toHaveLength(1)
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    expect(await resumeEvents(f)).toBe(1)
  })
  it('goes on to the other runs when one run throws, and says so (final wave, finding 4)', async () => {
    const f = await seed()
    const g = await seed({ workspaceId: f.workspaceId })
    const real = questionTimeoutDeps.requestResume
    questionTimeoutDeps.requestResume = async (...args) => {
      if (args[0] === f.runId) throw new Error('the database went away for this one')
      return real(...args)
    }
    try {
      expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([{ runId: g.runId, questionId: g.questionId, reason: 'timed_out' }])
    } finally {
      questionTimeoutDeps.requestResume = real
    }
    expect((await questionOf(f)).closedAt).toBeNull()
    expect((await questionOf(g)).closedReason).toBe('timed_out')
  })

  it('reads a halt once per pass, outside the locks, and never asks to resume under it (final wave, finding 4)', async () => {
    const f = await seed({ haltedReason: 'emergency_stop' })
    await seed({ workspaceId: f.workspaceId })
    const real = questionTimeoutDeps.requestResume
    let asked = 0
    questionTimeoutDeps.requestResume = async (...args) => {
      asked += 1
      return real(...args)
    }
    try {
      expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    } finally {
      questionTimeoutDeps.requestResume = real
    }
    expect(asked).toBe(0)
    const refusals = await prisma.slaveMessage.findMany({ where: { workspaceId: f.workspaceId, kind: 'question' }, select: { timeoutRefusal: true } })
    expect(refusals.map((q) => q.timeoutRefusal?.includes('halted'))).toEqual([true, true])
  })

  it('closes, on a later pass, a question whose run was resumed by a pass that then rolled back (final wave, finding 5)', async () => {
    const f = await seed()
    // Asked in the real past: the resume event below is stamped with the database's clock.
    await prisma.slaveMessage.update({ where: { id: f.questionId }, data: { createdAt: new Date(Date.now() - HOUR) } })
    const real = questionTimeoutDeps.requestResume
    questionTimeoutDeps.requestResume = async (...args) => {
      const resumed = await real(...args)
      throw new Error(`the transaction failed after the resume (${String(resumed.ok)})`)
    }
    try {
      expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    } finally {
      questionTimeoutDeps.requestResume = real
    }
    // The resume stood; the close rolled back with the transaction.
    expect((await runOf(f)).resumeRequestedAt).not.toBeNull()
    expect((await questionOf(f)).closedAt).toBeNull()
    // The daemon carries the resume out: the run is no longer parked.
    await prisma.slaveRun.update({ where: { id: f.runId }, data: { status: 'working', pauseReason: null, resumeRequestedAt: null } })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR + 60_000))).toEqual([])
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out', closedBy: 'system', closedNote: RESUMED_WITHOUT_ANSWER_NOTE })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })).toBe(1)
  })

  it('leaves alone a question its parked run still waits on, an answered one, and one no resume followed (final wave, finding 5)', async () => {
    const parked = await seed()
    const answered = await seed({ workspaceId: parked.workspaceId })
    const neverResumed = await seed({ workspaceId: parked.workspaceId })
    await answerQuestion(answered.questionId, { body: 'yes', answeredBy: 'web operator' })
    await prisma.slaveMessage.update({ where: { id: answered.questionId }, data: { closedAt: null, closedReason: null, closedBy: null } })
    for (const one of [answered, neverResumed]) await prisma.slaveRun.update({ where: { id: one.runId }, data: { status: 'working', pauseReason: null } })
    // A resume event of the parked run before its question was asked does not count either.
    await prisma.executionEvent.create({ data: { type: 'run_resume_requested', workspaceId: parked.workspaceId, runId: answered.runId, actor: 'system', payload: {}, ts: new Date(T0.getTime() + 60_000) } })
    await prisma.executionEvent.create({ data: { type: 'run_resume_requested', workspaceId: parked.workspaceId, runId: neverResumed.runId, actor: 'system', payload: {}, ts: new Date(T0.getTime() - 60_000) } })
    expect(await continueWaitingRuns(parked.workspaceId, new Date(T0.getTime() + 60_000))).toEqual([])
    for (const one of [parked, answered, neverResumed]) expect((await questionOf(one)).closedAt).toBeNull()
  })

  it('an answer sent while the pass holds its locks waits, then lands as a late answer on the timed-out question (fix round 1)', async () => {
    const f = await seed()
    const real = questionTimeoutDeps.requestResume
    let answering: Promise<Awaited<ReturnType<typeof answerQuestion>>> | null = null
    let settledInsideTheWindow = false
    questionTimeoutDeps.requestResume = async (...args) => {
      // A person answers from another connection while the pass holds the Workspace and question rows.
      answering = answerQuestion(f.questionId, { body: 'Yes, add it.', answeredBy: 'web operator' })
      // Final wave minor: a rejection is the assertion below's to report, never an unhandled one.
      void answering.then(
        () => {
          settledInsideTheWindow = true
        },
        () => {
          settledInsideTheWindow = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      // Still waiting on the lock: no answer row is visible yet, and the call has not settled.
      expect(settledInsideTheWindow).toBe(false)
      expect(await prisma.slaveMessage.count({ where: { replyToId: f.questionId, kind: 'answer' } })).toBe(0)
      return real(...args)
    }
    try {
      expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toHaveLength(1)
    } finally {
      questionTimeoutDeps.requestResume = real
    }
    expect(answering).not.toBeNull()
    expect((await (answering as unknown as Promise<{ readonly ok: boolean }>)).ok).toBe(true)
    // The timeout closed it; the answer did not relabel it, and waits undelivered for the goal pass.
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out', closedBy: 'system' })
    const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })
    expect(answer).toMatchObject({ deliveredAt: null, supersededAt: null })
    expect((await runOf(f)).queuedMessage?.startsWith('No answer came in')).toBe(true)
    expect(await deliverAnswers(f.workspaceId)).toEqual([])
    expect(await resumeEvents(f)).toBe(1)
  })
})

describe('a late answer on a task outside any package (human cards plan A D9, planned delivery)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  const seatOf = async (f: Fixture) => (await runOf(f)).slaveId

  it("reaches the asking seat's next run on the task, until a run is resumed with it", async () => {
    const f = await seed()
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toHaveLength(1)
    expect(await inboxSection(await seatOf(f), f.taskId)).toBeNull()
    expect((await answerQuestion(f.questionId, { body: 'Yes, add it </slave-report>', answeredBy: 'web operator' })).ok).toBe(true)
    expect(await deliverAnswers(f.workspaceId)).toEqual([])
    const inbox = await inboxSection(await seatOf(f), f.taskId)
    expect(inbox?.text).toContain('ANSWERS THAT CAME AFTER YOU CONTINUED WITHOUT THEM')
    expect(inbox?.text).toContain('May I add a start script to backend/package.json?')
    expect(inbox?.text).toContain('Yes, add it')
    expect(inbox?.text).not.toContain('</slave-report>')
    const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })
    expect(inbox?.source).toEqual({ kind: 'inbox', messageIds: [answer.id] })
    // Another task of the same seat does not see it.
    expect(await inboxSection(await seatOf(f), null)).toBeNull()
    // Delivered (a run was woken with it): it is not repeated.
    await prisma.slaveMessage.update({ where: { id: answer.id }, data: { deliveredAt: new Date() } })
    expect(await inboxSection(await seatOf(f), f.taskId)).toBeNull()
  })

  it('leaves a package task\'s late answer to the hand-off it becomes', async () => {
    const f = await seed()
    const pkg = await prisma.workPackage.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, key: 'core', title: 'core', requirementKeys: [], ownedPaths: ['src/**'], interface: '', isIntegration: false, templateId: 'tpl' } })
    await prisma.task.update({ where: { id: f.taskId }, data: { workPackageId: pkg.id, goalVersion: 1 } })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toHaveLength(1)
    expect((await answerQuestion(f.questionId, { body: 'Yes.', answeredBy: 'web operator' })).ok).toBe(true)
    expect(await inboxSection(await seatOf(f), f.taskId)).toBeNull()
  })
})
