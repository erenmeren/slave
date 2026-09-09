import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerQuestion, listPendingQuestions, sendMessage } from '../../src/messaging.js'

interface Fixture {
  readonly workspaceId: string
  readonly askerId: string
  readonly answererId: string
  readonly runId: string
  readonly taskId: string
}

/**
 * One workspace: an asker mid-run, and a second worker holding the RUNTIME role it addresses.
 *
 * The titles are deliberately different strings from the runtime roles (M37 t3): role addressing
 * matches `runtimeRoles` now, so a fixture where the two agreed would pass whichever column the
 * implementation happened to read.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const asker = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'Senior Engineer', runtimeRoles: ['asker'] },
  })
  const answerer = await prisma.slave.create({
    data: { teamId: team.id, name: 'Maya', role: 'Product Lead', runtimeRoles: ['answerer'] },
  })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'retry', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: asker.id, status: 'working' } })
  return { workspaceId: workspace.id, askerId: asker.id, answererId: answerer.id, runId: run.id, taskId: task.id }
}

/**
 * Asks, and parks the asking run exactly as `apps/orchestrator/src/ask.ts` parks it.
 *
 * The park is not decoration: since the final review a question is pending only while its asker is
 * still `paused` with `pauseReason = waiting_for_answer` (`stillPendingQuestion` in
 * `src/messaging.ts`), because a question nobody is waiting on is a zombie in every recipient's
 * prompt. A `working` run that sent a question is a shape production never produces -- the ask path
 * sends and parks in the same conclusion -- so the fixture reproduces both halves.
 */
async function askAQuestion(fixture: Fixture): Promise<string> {
  const sent = await sendMessage(fixture.runId, {
    kind: 'question',
    body: 'Which queue should retries land on?',
    recipientRole: 'answerer',
    expectsReply: true,
    taskId: fixture.taskId,
  })
  if (!sent.ok) throw new Error(`the fixture could not ask: ${JSON.stringify(sent.error)}`)
  await prisma.slaveRun.update({
    where: { id: fixture.runId },
    data: { status: 'paused', pauseReason: 'waiting_for_answer' },
  })
  return sent.value.id
}

describe('answerQuestion -- a human answers a worker', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('writes an answer in the question thread, attributed to a human and to no run', async () => {
    const questionId = await askAQuestion(fixture)

    const result = await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.kind).toBe('answer')
    expect(row.actor).toBe('human')
    expect(row.senderRunId).toBeNull()
    expect(row.replyToId).toBe(questionId)
    expect(row.body).toBe('payments-retry')
    expect(row.expectsReply).toBe(false)
    expect(row.deliveredAt).toBeNull()
    // The thread the question opened, not a new one.
    const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
    expect(row.threadId).toBe(question.threadId)
    // Addressed to the slave that asked, and attributed to it the way every pre-M36 human message
    // on this table is (`actor: 'human'` + `slaveId` = who the human addressed).
    expect(row.slaveId).toBe(fixture.askerId)
    expect(row.recipientSlaveId).toBe(fixture.askerId)
    expect(row.workspaceId).toBe(fixture.workspaceId)
    expect(row.taskId).toBe(fixture.taskId)
  })

  it('announces the answer on the same event every send announces', async () => {
    const questionId = await askAQuestion(fixture)
    await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })

    const events = await prisma.executionEvent.findMany({ where: { type: 'slave_message_sent' }, orderBy: { seq: 'asc' } })
    expect(events).toHaveLength(2)
    const answered = events[1]
    expect(answered?.actor).toBe('human')
    expect(answered?.slaveId).toBe(fixture.askerId)
    expect((answered?.payload as { kind?: string }).kind).toBe('answer')
  })

  it('writes ONE row when the same operator answer is replayed', async () => {
    const questionId = await askAQuestion(fixture)

    const first = await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })
    const second = await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.id).toBe(first.value.id)
    expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(1)
  })

  it('writes a SECOND row when the operator says something different', async () => {
    const questionId = await askAQuestion(fixture)
    await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })
    await answerQuestion(questionId, { body: 'no -- payments-dlq', answeredBy: 'operator' })

    expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(2)
  })

  it('refuses a message id nobody wrote', async () => {
    const result = await answerQuestion('00000000-0000-0000-0000-000000000000', { body: 'x', answeredBy: 'operator' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('message_not_found')
  })

  it('refuses a message that is not a question', async () => {
    const sent = await sendMessage(fixture.runId, { kind: 'information', body: 'FYI', recipientRole: 'answerer' })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const result = await answerQuestion(sent.value.id, { body: 'x', answeredBy: 'operator' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('not_a_question')
  })

  it('refuses an empty answer rather than writing a blank message', async () => {
    const questionId = await askAQuestion(fixture)
    const result = await answerQuestion(questionId, { body: '   ', answeredBy: 'operator' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_message_body')
  })
})

describe('listPendingQuestions', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('lists the workspace unanswered questions, and drops one once it is answered', async () => {
    const questionId = await askAQuestion(fixture)

    const before = await listPendingQuestions(fixture.workspaceId)
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.value.map((message) => message.id)).toEqual([questionId])

    await answerQuestion(questionId, { body: 'payments-retry', answeredBy: 'operator' })

    const after = await listPendingQuestions(fixture.workspaceId)
    expect(after.ok && after.value).toEqual([])
  })

  it('refuses a workspace that does not exist', async () => {
    const result = await listPendingQuestions('00000000-0000-0000-0000-000000000000')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('workspace_not_found')
  })
})
