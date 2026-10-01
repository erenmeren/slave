/**
 * Human-cards plan A, Task 3: a question closes once, a closed question is pending nowhere, an answer
 * closes its question, and the cards of a closed question are retired.
 */
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, QUESTION_SITUATION_KINDS } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { answerQuestion, listPendingQuestions, reportQuestionKey, sendMessage } from '../../src/messaging.js'
import { closeQuestion, retireClosedQuestionCards, retireQuestionCards } from '../../src/questions.js'
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
})
