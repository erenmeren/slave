/**
 * Human-cards spec H3 (plan A D7): a run paused on an unanswered question past the project's question
 * timeout continues on its own judgement; a halt keeps it waiting and says why; an answer and the
 * timeout in one window produce one resume.
 */
import { answerQuestion } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverAnswers } from '../../src/deliver.js'
import { continueWaitingRuns } from '../../src/questionTimeout.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'
const HOUR = 3_600_000
const T0 = new Date('2026-10-02T08:00:00.000Z')

interface Fixture {
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  readonly questionId: string
}

/** A run parked on a question at T0, with a checkpoint (a resume needs one) and a dead pid. */
async function seed(options: { readonly timeoutMs?: number; readonly haltedReason?: string } = {}): Promise<Fixture> {
  const ws = await prisma.workspace.create({
    data: {
      name: `Timeout ${String(Math.random())}`,
      repoPath: '/nonexistent',
      verifyCommands: ['true'],
      setupCommands: [],
      ...(options.timeoutMs === undefined ? {} : { questionTimeoutMs: options.timeoutMs }),
      ...(options.haltedReason === undefined ? {} : { haltedReason: options.haltedReason, haltedAt: T0 }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const person = await prisma.person.create({ data: { name: 'Ivo' } })
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
})
