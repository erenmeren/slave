/**
 * Human-cards plan A, Task 3: a question closes once, a closed question is pending nowhere, an answer
 * closes its question, and the cards of a closed question are retired.
 */
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, LATE_ANSWER_NOTE, QUESTION_SITUATION_KINDS } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { answerQuestion, listPendingQuestions, reportQuestionKey, sendMessage } from '../../src/messaging.js'
import { expirePendingDecisions } from '../../src/supervisor.js'
import { closeQuestion, lateAnswerFate, loadQuestionCards, retireClosedQuestionCards, retireQuestionCards } from '../../src/questions.js'
import { loadSupervisorWorld } from '../../src/supervisorWorld.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE'

interface Fixture { readonly workspaceId: string; readonly seatId: string; readonly taskId: string }

async function seed(): Promise<Fixture> {
  // The events of a person's close name them by account (`ExecutionEvent.userId` is a foreign key).
  await prisma.user.createMany({ data: [{ id: 'u1', username: 'u1', passwordHash: 'x' }, { id: 'u9', username: 'u9', passwordHash: 'x' }] })
  const ws = await prisma.workspace.create({ data: { name: `Questions ${String(Date.now())}`, repoPath: '/nonexistent', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'report', description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1 } })
  return { workspaceId: ws.id, seatId: seat.id, taskId: task.id }
}

/** Puts the fixture's task in a package of goal version 1, whose delivery is `status` (none: no row). */
async function inPackage(f: Fixture, status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned' | null, merged = false): Promise<void> {
  const pkg = await prisma.workPackage.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, key: 'report', title: 'report', requirementKeys: [], ownedPaths: ['src/**'], interface: '', isIntegration: false, templateId: 'tpl' } })
  await prisma.task.update({ where: { id: f.taskId }, data: { workPackageId: pkg.id } })
  if (status !== null) {
    await prisma.goalDelivery.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'a'.repeat(40), status, ...(merged ? { mergedAt: new Date() } : {}) } })
  }
}

async function reportQuestion(f: Fixture, body = 'Which error shape?'): Promise<string> {
  const run = await prisma.slaveRun.create({ data: { slaveId: f.seatId, taskId: f.taskId, status: 'succeeded' } })
  const sent = await sendMessage(run.id, { kind: 'question', body, recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: f.taskId, idempotencyKey: reportQuestionKey(run.id, 0) })
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  return sent.value.id
}

const card = (f: Fixture, subjectId: string, situationKind: 'conductor_question' | 'waiting_stale' | 'unanswerable_question', status: 'pending' | 'rejected' = 'pending') =>
  prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind, subjectId, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status, decidedBy: 'rules' } })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('closing a question (human cards H1)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('closes once: the second close writes nothing and the first reason stays', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    expect(await closeQuestion({ messageId: q, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'n' }, 'human', 'u1')).toBe(true)
    expect(await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)).toBe(false)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).toMatchObject({ closedReason: 'dismissed', closedBy: 'u1', closedNote: 'n' })
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor: 'human', taskId: f.taskId })
  })

  it('is pending nowhere once closed: not in the answer box, not in the world', async () => {
    const f = await seed()
    const open = await reportQuestion(f, 'open one')
    const closed = await reportQuestion(f, 'closed one')
    await closeQuestion({ messageId: closed, reason: 'decided', by: 'u1', decisionId: null, note: () => null }, 'human', 'u1')
    const pending = await listPendingQuestions(f.workspaceId)
    expect(pending.ok && pending.value.map((m) => m.id)).toEqual([open])
    const { world } = await loadSupervisorWorld(f.workspaceId, new Date())
    expect(world.questions.map((one) => one.messageId)).toEqual([open])
  })

  it('closes a question answered, naming who; and a dismissed one refuses an answer', async () => {
    const f = await seed()
    const answered = await reportQuestion(f, 'a')
    const result = await answerQuestion(answered, { body: 'camelCase', answeredBy: 'web operator', principal: { userId: 'u9' } })
    expect(result.ok).toBe(true)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: answered } })).toMatchObject({ closedReason: 'answered', closedBy: 'u9', closedNote: null })
    const cli = await reportQuestion(f, 'b')
    await answerQuestion(cli, { body: 'yes', answeredBy: 'cli' })
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: cli } })).closedBy).toBe('operator')
    const dismissed = await reportQuestion(f, 'c')
    await closeQuestion({ messageId: dismissed, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'x' }, 'human', 'u1')
    const refused = await answerQuestion(dismissed, { body: 'late', answeredBy: 'web operator' })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.kind).toBe('question_closed')
    expect(await prisma.slaveMessage.count({ where: { replyToId: dismissed } })).toBe(0)
  })

  it('takes a late answer on a timed-out question and keeps its reason (plan A D6)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => 'No answer came in 2 hours.' }, 'system', null)
    expect((await answerQuestion(q, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).closedReason).toBe('timed_out')
  })

  it('retires every open card of a question but the one named, and the backstop leaves a timed-out question\'s card open', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    const keep = await card(f, q, 'conductor_question')
    const other = await card(f, q, 'waiting_stale')
    expect(await retireQuestionCards(f.workspaceId, q, 'answered elsewhere', new Date(), keep.id)).toBe(1)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('expired')
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe('pending')

    const timedOut = await reportQuestion(f, 'waits')
    const stays = await card(f, timedOut, 'conductor_question')
    await closeQuestion({ messageId: timedOut, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    await closeQuestion({ messageId: q, reason: 'answered', by: 'u1', decisionId: null, note: () => null }, 'human', 'u1')
    expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(1)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe('expired')
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: stays.id } })).status).toBe('pending')
    expect(QUESTION_SITUATION_KINDS).toEqual(['waiting_stale', 'unanswerable_question', 'conductor_question'])
  })

  it('retires a timed-out question\'s open card once a late answer is on record, saying where it goes (ruling F7, fix round 1)', async () => {
    const f = await seed()
    await inPackage(f, 'integrating')
    const q = await reportQuestion(f)
    const open = await card(f, q, 'conductor_question')
    await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(0)
    // Written directly: the answer path's own retire is what crashed, and the backstop catches it.
    const asked = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })
    await prisma.slaveMessage.create({ data: { workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.seatId, recipientSlaveId: f.seatId, threadId: asked.threadId, replyToId: q, kind: 'answer', body: 'late', actor: 'human' } })
    expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(1)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('expired')
    const said = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'supervisor_resolved' } })
    expect(said.map((e) => (e.payload as { reason: string }).reason)).toEqual([LATE_ANSWER_NOTE.hand_off])
  })

  it('keeps the card of a late answer no run will read open: a finished task outside any package (fix round 1)', async () => {
    const f = await seed() // its task is done and has no package
    const q = await reportQuestion(f)
    const open = await card(f, q, 'conductor_question')
    await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    expect((await answerQuestion(q, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(0)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('pending')
    expect(await lateAnswerFate(prisma, q)).toBe('unread')
    expect(LATE_ANSWER_NOTE.unread).toBe('The answer came after its run continued; no run will read it.')
  })

  // Final wave round 2 (I5): `hand_off` only where routing really delivers the item to a run of the
  // package (`handOffRoute` = delivered): an integrating version, a task that can take it.
  for (const [taskStatus, fate] of [
    ['done', 'hand_off'],
    ['running', 'hand_off'],
    ['failed', 'unread'],
  ] as const) {
    it(`says a late answer to an integrating version's ${taskStatus} package task is ${fate} (final wave round 2)`, async () => {
      const f = await seed()
      await inPackage(f, 'integrating')
      await prisma.task.update({ where: { id: f.taskId }, data: { status: taskStatus } })
      const q = await reportQuestion(f)
      await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
      expect(await lateAnswerFate(prisma, q)).toBe(fate)
      expect((await loadQuestionCards(f.workspaceId, [q])).get(q)?.lateAnswerFate).toBe(fate)
    })
  }

  for (const [label, status, merged] of [
    ['merged', 'accepted', true],
    // Final wave round 2 (I5): accepted and not merged (auto-merge off) still has its delivery open
    // to the goal pass, but routing stores every item for an accepted version `expired`.
    ['accepted and not merged', 'accepted', false],
    // An item stored while verifying stays pending and no run is shown it; an accepted round then
    // expires it unread. It reaches a run only if the round fails back to integrating.
    ['verifying', 'verifying', false],
    ['abandoned', 'abandoned', false],
    ['waiting on a person', 'needs_human', false],
    ['never delivered', null, false],
  ] as const) {
    it(`keeps a late answer's card open, unread, when its package's goal version is ${label} (final wave, finding 6)`, async () => {
      const f = await seed()
      await inPackage(f, status, merged)
      const q = await reportQuestion(f)
      const open = await card(f, q, 'conductor_question')
      await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
      expect(await lateAnswerFate(prisma, q)).toBe('unread')
      expect((await answerQuestion(q, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
      expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(0)
      expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('pending')
      expect((await loadQuestionCards(f.workspaceId, [q])).get(q)).toMatchObject({ lateAnswerFate: 'unread', lateAnswerNote: LATE_ANSWER_NOTE.unread })
    })
  }

  it('retires a late answer\'s cards from the answer path with where it goes, and an on-time answer\'s as answered (fix round 1)', async () => {
    const f = await seed()
    await prisma.task.update({ where: { id: f.taskId }, data: { status: 'running' } })
    const late = await reportQuestion(f, 'late one')
    const lateCard = await card(f, late, 'conductor_question')
    await closeQuestion({ messageId: late, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    expect((await answerQuestion(late, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    const onTime = await reportQuestion(f, 'on time')
    const onTimeCard = await card(f, onTime, 'waiting_stale')
    expect((await answerQuestion(onTime, { body: 'now', answeredBy: 'web operator' })).ok).toBe(true)
    const reasons = async (decisionId: string) =>
      (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'supervisor_resolved' } }))
        .map((e) => e.payload as { decisionId: string; reason: string })
        .filter((p) => p.decisionId === decisionId)
        .map((p) => p.reason)
    expect(await reasons(lateCard.id)).toEqual([LATE_ANSWER_NOTE.next_run])
    expect(await reasons(onTimeCard.id)).toEqual(['The question was answered.'])
  })

  it('reads a card\'s question: its package, whether the asker waits, its close and why the run cannot continue', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await prisma.slaveMessage.update({ where: { id: q }, data: { closedAt: new Date('2026-10-02T10:00:00.000Z'), closedReason: 'timed_out', closedBy: 'system', timeoutRefusal: 'the project is halted' } })
    const cards = await loadQuestionCards(f.workspaceId, [q, 'not-a-message'])
    expect(cards.get(q)).toMatchObject({ messageId: q, askerWaiting: false, closed: { reason: 'timed_out', by: 'system', at: '2026-10-02T10:00:00.000Z' }, timeoutRefusal: 'the project is halted', goalVersion: 1 })
    expect(cards.has('not-a-message')).toBe(false)
  })

  it('names who closed a card\'s question, says when its parked asker still waits, and carries the note of a late answer no run will read (human cards H1/H3)', async () => {
    const f = await seed() // its task is done and has no package: a late answer is unread
    const byPerson = await reportQuestion(f, 'by a person')
    await closeQuestion({ messageId: byPerson, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'x' }, 'human', 'u1')
    const byOperator = await reportQuestion(f, 'by an operator')
    await closeQuestion({ messageId: byOperator, reason: 'decided', by: 'operator', decisionId: null, note: () => null }, 'human', null)
    const unread = await reportQuestion(f, 'answered late')
    await closeQuestion({ messageId: unread, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    expect((await answerQuestion(unread, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    const timedOut = await reportQuestion(f, 'no answer yet')
    await closeQuestion({ messageId: timedOut, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    // A parked asker: its run waits on its latest question, and the timeout pass was refused.
    const run = await prisma.slaveRun.create({ data: { slaveId: f.seatId, taskId: f.taskId, status: 'paused', pauseReason: 'waiting_for_answer' } })
    const waiting = await sendMessage(run.id, { kind: 'question', body: 'parked', recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: f.taskId })
    if (!waiting.ok) throw new Error(JSON.stringify(waiting.error))
    await prisma.slaveMessage.update({ where: { id: waiting.value.id }, data: { timeoutRefusal: 'workspace halted: emergency_stop' } })

    const cards = await loadQuestionCards(f.workspaceId, [byPerson, byOperator, unread, timedOut, waiting.value.id])

    expect(cards.get(byPerson)?.closed).toMatchObject({ reason: 'dismissed', by: 'u1', byName: 'u1' })
    expect(cards.get(byOperator)?.closed).toMatchObject({ reason: 'decided', by: 'operator', byName: 'an operator' })
    expect(cards.get(unread)).toMatchObject({ lateAnswerNote: LATE_ANSWER_NOTE.unread, lateAnswerFate: 'unread' })
    expect(cards.get(timedOut)).toMatchObject({ closed: { reason: 'timed_out', byName: 'Slave' }, lateAnswerNote: null, lateAnswerFate: 'unread' })
    expect(cards.get(byPerson)?.lateAnswerFate).toBe(null)
    expect(cards.get(waiting.value.id)).toMatchObject({ askerWaiting: true, askerRunId: run.id, closed: null, timeoutRefusal: 'workspace halted: emergency_stop' })
  })

  // Final wave, finding 1: a worker's answer (`sendMessage` kind 'answer', the path
  // `apps/orchestrator/src/answer.ts` takes) closes its question as a person's does.
  const peerAnswers = async (f: Fixture, questionId: string, body = 'use camelCase') => {
    const team = await prisma.slave.findUniqueOrThrow({ where: { id: f.seatId }, select: { teamId: true } })
    const peer = await prisma.slave.create({ data: { teamId: team.teamId, role: 'Conductor', runtimeRoles: [CONDUCTOR_ROLE], personId: (await prisma.person.create({ data: { name: 'Cleo' } })).id } })
    const run = await prisma.slaveRun.create({ data: { slaveId: peer.id, status: 'working' } })
    const asked = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
    return sendMessage(run.id, { kind: 'answer', body, recipientSlaveId: asked.slaveId, replyToId: questionId, idempotencyKey: `answer:${run.id}:${questionId}` })
  }

  it('closes a question a worker answered, by the system, and retires its open card (final wave, finding 1)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    const open = await card(f, q, 'conductor_question')
    const sent = await peerAnswers(f, q)
    expect(sent.ok).toBe(true)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).toMatchObject({ closedReason: 'answered', closedBy: 'system', closedNote: null })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('expired')
    const closedEvents = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })
    expect(closedEvents.map((e) => (e.payload as { reason: string; by: string })).map((p) => [p.reason, p.by])).toEqual([['answered', 'system']])
    // The card no longer waits a day to expire as `timed_out`: an expiry pass a day later finds nothing.
    expect(await expirePendingDecisions(f.workspaceId, new Date(Date.now() + 25 * 3_600_000))).toBe(0)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).closedReason).toBe('answered')
  })

  it('refuses a worker\'s answer to a dismissed question, writing nothing (final wave, finding 1)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await closeQuestion({ messageId: q, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'x' }, 'human', 'u1')
    const sent = await peerAnswers(f, q)
    expect(!sent.ok && sent.error.kind).toBe('question_closed')
    expect(await prisma.slaveMessage.count({ where: { replyToId: q } })).toBe(0)
  })

  it('takes a worker\'s late answer on a timed-out question, keeping its reason (final wave, finding 1)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    expect((await peerAnswers(f, q)).ok).toBe(true)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).closedReason).toBe('timed_out')
  })

  it('does not time out, on its card\'s expiry, a question that has a live answer (final wave, finding 1 guard)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    const asked = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })
    // An answer whose close was never written (one stored before the worker path closed questions).
    await prisma.slaveMessage.create({ data: { workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.seatId, recipientSlaveId: f.seatId, threadId: asked.threadId, replyToId: q, kind: 'answer', body: 'yes', actor: 'slave' } })
    const due = await card(f, q, 'conductor_question')
    await prisma.supervisorDecision.update({ where: { id: due.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await expirePendingDecisions(f.workspaceId, new Date())).toBe(1)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).closedAt).toBe(null)
  })

  it('stores an answer with a NUL byte stripped instead of refusing it (fix round 1)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    const sent = await answerQuestion(q, { body: 'camel\u0000Case', answeredBy: 'web operator' })
    expect(sent.ok && sent.value.body).toBe('camelCase')
    expect((await answerQuestion(q, { body: '\u0000 ', answeredBy: 'web operator' })).ok).toBe(false)
  })
})
