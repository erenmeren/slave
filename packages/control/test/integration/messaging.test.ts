import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  answerQuestion, listMessagesForSlave, markMessageRead, reassignQuestion, sendMessage,
  type SendMessageInput,
} from '../../src/messaging.js'

interface Fixture {
  readonly workspace: { readonly id: string }
  readonly otherWorkspace: { readonly id: string }
  /** `role` here is the RUNTIME role a message addresses (M37 t3), not `Slave.role` -- the two
   *  are deliberately different strings on every row this fixture makes. */
  readonly sender: { readonly id: string; readonly role: string }
  readonly recipient: { readonly id: string; readonly role: string }
  readonly outsider: { readonly id: string }
  readonly run: { readonly id: string }
}

/**
 * One workspace with a sender and a named recipient (runtime roles "asker"/"answerer" so the
 * role-based addressing tests are unambiguous), a run that sender is mid-way through, and one slave
 * in a SECOND workspace for the cross-workspace refusal.
 *
 * Every slave's TITLE (`Slave.role`) is deliberately a different string from its runtime role
 * (M37 t3): role addressing matches `runtimeRoles` now, so a fixture where the two agreed would
 * pass whichever column the implementation happened to read.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const otherWorkspace = await prisma.workspace.create({
    data: { name: 'Other Platform', repoPath: '/tmp/other', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: otherWorkspace.id, name: 'Engineering' } })

  const sender = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'Senior Engineer', runtimeRoles: ['asker'] },
  })
  const recipient = await prisma.slave.create({
    data: { teamId: team.id, name: 'Maya', role: 'Product Lead', runtimeRoles: ['answerer'] },
  })
  const outsider = await prisma.slave.create({
    data: { teamId: otherTeam.id, name: 'Zoe', role: 'Product Lead', runtimeRoles: ['answerer'] },
  })

  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: sender.id, status: 'working' } })

  return {
    workspace: { id: workspace.id },
    otherWorkspace: { id: otherWorkspace.id },
    sender: { id: sender.id, role: sender.runtimeRoles[0] ?? '' },
    recipient: { id: recipient.id, role: recipient.runtimeRoles[0] ?? '' },
    outsider: { id: outsider.id },
    run: { id: run.id },
  }
}

/**
 * Parks the asking run the way `apps/orchestrator/src/ask.ts` does at its conclusion.
 *
 * Required by `unansweredOnly` since the final review: a question is pending only while its asker
 * is still `paused` with `pauseReason = waiting_for_answer`, so that a run resumed by anything
 * other than its answer stops re-injecting a question nobody is waiting on into every subsequent
 * run of its recipient. The ask path sends and parks in one conclusion; so does this.
 */
async function parkAsWaiting(runId: string): Promise<void> {
  await prisma.slaveRun.update({ where: { id: runId }, data: { status: 'paused', pauseReason: 'waiting_for_answer' } })
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
}

const eventsOfType = (type: string) =>
  prisma.executionEvent.findMany({ where: { type: type as never }, orderBy: { seq: 'asc' } })

/** The sender asks the `answerer` ROLE, and parks the way `ask.ts` does. Returns the question id. */
async function askAsRole(fixture: Fixture): Promise<string> {
  const sent = await sendMessage(fixture.run.id, { kind: 'question', body: 'Which queue?', expectsReply: true, recipientRole: 'answerer' })
  if (!sent.ok) throw new Error('the fixture could not ask by role')
  await parkAsWaiting(fixture.run.id)
  return sent.value.id
}

/** The same, addressed to ONE worker -- and optionally carrying the task it is about, which is
 *  where a slave-addressed question gets the role a re-address is judged against (erratum E5). */
async function askDirectly(fixture: Fixture, toSlaveId: string, taskId: string | null): Promise<string> {
  const sent = await sendMessage(fixture.run.id, {
    kind: 'question',
    body: 'Which queue?',
    expectsReply: true,
    recipientSlaveId: toSlaveId,
    taskId,
  })
  if (!sent.ok) throw new Error('the fixture could not ask directly')
  await parkAsWaiting(fixture.run.id)
  return sent.value.id
}

/** A second worker in the same project holding exactly `role`. */
async function peerHolding(fixture: Fixture, role: string, name: string): Promise<string> {
  const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspace.id } })
  const peer = await prisma.slave.create({
    data: { teamId: team.id, name, role: 'Staff Engineer', runtimeRoles: [role] },
  })
  return peer.id
}

/** A task in the project that can only be dispatched to holders of `role`. */
async function taskRequiring(fixture: Fixture, role: string): Promise<string> {
  const task = await prisma.task.create({
    data: { workspaceId: fixture.workspace.id, title: 'Wire the queue', description: 'x', requiredRole: role, maxAttempts: 3 },
  })
  return task.id
}

/** The unanswered questions in a worker's inbox, by id. */
async function inboxOf(slaveId: string): Promise<string[]> {
  const inbox = await listMessagesForSlave(slaveId, { unansweredOnly: true })
  if (!inbox.ok) throw new Error('the fixture could not read an inbox')
  return inbox.value.map((message) => message.id)
}

const question = (over: Partial<SendMessageInput> = {}): SendMessageInput => ({
  kind: 'question',
  body: 'Which queue should retries land on?',
  expectsReply: true,
  ...over,
})

describe('sendMessage', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('resolves the sender from the run, ignoring any caller-supplied identity', async () => {
    const { run, recipient, sender } = fixture
    // Cast past `SendMessageInput`'s own type (which has no sender field to begin with) to prove
    // the RUNTIME behaviour, not just that the compiler would reject it: an extra `slaveId` key
    // smuggled onto the input object must still be ignored.
    const input = { ...question({ recipientSlaveId: recipient.id }), slaveId: 'someone-else' } as SendMessageInput

    const result = await sendMessage(run.id, input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.senderSlaveId).toBe(sender.id)
    expect(result.value.senderRunId).toBe(run.id)

    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.slaveId).toBe(sender.id)
  })

  it('refuses an unknown run', async () => {
    const { recipient } = fixture
    const result = await sendMessage('00000000-0000-4000-8000-000000000000', question({ recipientSlaveId: recipient.id }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })

  it('refuses a recipient in another workspace', async () => {
    const { run, outsider } = fixture
    const result = await sendMessage(run.id, question({ recipientSlaveId: outsider.id }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('cross_workspace')

    expect(await prisma.slaveMessage.count()).toBe(0)
  })

  it('refuses an unknown named recipient', async () => {
    const { run } = fixture
    const result = await sendMessage(run.id, question({ recipientSlaveId: '00000000-0000-4000-8000-000000000000' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('slave_not_found')
  })

  it('refuses a recipient naming neither a slave nor a role', async () => {
    const { run } = fixture
    const result = await sendMessage(run.id, question({}))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('invalid_recipient')
  })

  it('refuses a recipient naming both a slave and a role', async () => {
    const { run, recipient } = fixture
    const result = await sendMessage(run.id, question({ recipientSlaveId: recipient.id, recipientRole: 'answerer' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('invalid_recipient')
  })

  it('refuses a blank body', async () => {
    const { run, recipient } = fixture
    const result = await sendMessage(run.id, question({ recipientSlaveId: recipient.id, body: '   ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('invalid_message_body')
  })

  it('replays the same idempotency key rather than writing twice', async () => {
    const { run, recipient } = fixture
    const input = question({ recipientSlaveId: recipient.id, idempotencyKey: 'ask-1' })

    const first = await sendMessage(run.id, input)
    const second = await sendMessage(run.id, { ...input, body: 'a different body, same key' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.id).toBe(first.value.id)
    expect(second.value.body).toBe(first.value.body)

    expect(await prisma.slaveMessage.count()).toBe(1)
    const events = await prisma.executionEvent.findMany({ where: { type: 'slave_message_sent' } })
    expect(events).toHaveLength(1)
  })

  it('a different idempotency key writes a second, distinct message', async () => {
    const { run, recipient } = fixture
    await sendMessage(run.id, question({ recipientSlaveId: recipient.id, idempotencyKey: 'ask-1' }))
    await sendMessage(run.id, question({ recipientSlaveId: recipient.id, idempotencyKey: 'ask-2' }))
    expect(await prisma.slaveMessage.count()).toBe(2)
  })

  it('emits slave.message_sent with the sender as actor and slave, and the send in its payload', async () => {
    const { run, recipient, sender } = fixture
    const result = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const event = await prisma.executionEvent.findFirst({ where: { type: 'slave_message_sent' } })
    expect(event?.actor).toBe('slave')
    expect(event?.slaveId).toBe(sender.id)
    expect(event?.runId).toBe(run.id)
    expect(event?.payload).toEqual({
      messageId: result.value.id,
      kind: 'question',
      body: question().body,
      threadId: result.value.threadId,
      replyToId: null,
      recipientSlaveId: recipient.id,
      recipientRole: null,
      expectsReply: true,
    })
  })

  it('addresses every worker holding a role, not a specific worker', async () => {
    const { run, recipient } = fixture
    const result = await sendMessage(run.id, question({ recipientRole: 'answerer' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.recipientSlaveId).toBeNull()
    expect(result.value.recipientRole).toBe('answerer')

    const inbox = await listMessagesForSlave(recipient.id)
    expect(inbox.ok).toBe(true)
    if (inbox.ok) expect(inbox.value.map((m) => m.id)).toEqual([result.value.id])
  })

  // M37 t3: the two halves of "role addressing is `runtimeRoles`". The recipient's TITLE is
  // "Product Lead" and reaches nobody; a second holder of the same runtime role, whose title is
  // different again, is reached by the same one message.
  it('reaches every holder of a RUNTIME role, and nobody by their title', async () => {
    const { run, recipient } = fixture
    const recipientRow = await prisma.slave.findUniqueOrThrow({ where: { id: recipient.id } })
    const second = await prisma.slave.create({
      data: { teamId: recipientRow.teamId, name: 'Noor', role: 'Support Engineer', runtimeRoles: ['answerer', 'triage'] },
    })

    const byTitle = await sendMessage(run.id, question({ recipientRole: 'Product Lead' }))
    expect(byTitle.ok).toBe(true)
    if (!byTitle.ok) return
    const sent = await sendMessage(run.id, question({ recipientRole: 'answerer' }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    for (const holder of [recipient.id, second.id]) {
      const inbox = await listMessagesForSlave(holder)
      expect(inbox.ok).toBe(true)
      // Only the runtime-role broadcast; the title-addressed one reached nobody at all.
      if (inbox.ok) expect(inbox.value.map((m) => m.id)).toEqual([sent.value.id])
    }
  })

  it('never lets an empty runtime role set be reached by any broadcast', async () => {
    const { run, recipient } = fixture
    await prisma.slave.update({ where: { id: recipient.id }, data: { runtimeRoles: [] } })
    const sent = await sendMessage(run.id, question({ recipientRole: 'answerer' }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const inbox = await listMessagesForSlave(recipient.id)
    expect(inbox.ok).toBe(true)
    if (inbox.ok) expect(inbox.value).toEqual([])

    // And it may not mark it read either -- the two reads share one definition of "addressed to".
    const read = await markMessageRead(sent.value.id, recipient.id)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.kind).toBe('not_message_recipient')
  })

  it('a reply inherits its parent thread, and the thread reads back in order', async () => {
    const { run, recipient } = fixture
    const opener = await sendMessage(run.id, question({ recipientSlaveId: recipient.id, body: 'first' }))
    expect(opener.ok).toBe(true)
    if (!opener.ok) return
    expect(opener.value.threadId).toBe(opener.value.id)

    // A second run, standing in for the recipient's own worker replying back.
    const secondRun = await prisma.slaveRun.create({ data: { slaveId: recipient.id, status: 'working' } })
    const reply = await sendMessage(secondRun.id, {
      kind: 'answer',
      body: 'second',
      recipientSlaveId: fixture.sender.id,
      replyToId: opener.value.id,
      threadId: 'a-caller-supplied-id-that-must-be-ignored',
    })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.value.threadId).toBe(opener.value.threadId)
    expect(reply.value.replyToId).toBe(opener.value.id)

    const senderInbox = await listMessagesForSlave(fixture.sender.id)
    expect(senderInbox.ok).toBe(true)
    if (senderInbox.ok) expect(senderInbox.value.map((m) => m.body)).toEqual(['second'])

    const recipientInbox = await listMessagesForSlave(recipient.id)
    expect(recipientInbox.ok).toBe(true)
    if (recipientInbox.ok) expect(recipientInbox.value.map((m) => m.body)).toEqual(['first'])
  })

  it('refuses a reply to a message in another workspace as message_not_found', async () => {
    const { run, outsider, otherWorkspace } = fixture
    const outsiderTask = await prisma.task.create({
      data: { workspaceId: otherWorkspace.id, title: 'Other task', description: 'x', maxAttempts: 3 },
    })
    const outsiderRun = await prisma.slaveRun.create({ data: { taskId: outsiderTask.id, slaveId: outsider.id, status: 'working' } })
    const outsiderMessage = await sendMessage(outsiderRun.id, question({ recipientRole: 'answerer' }))
    expect(outsiderMessage.ok).toBe(true)
    if (!outsiderMessage.ok) return

    const result = await sendMessage(run.id, {
      kind: 'answer',
      body: 'reaching across',
      recipientSlaveId: fixture.recipient.id,
      replyToId: outsiderMessage.value.id,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('message_not_found')
  })
})

describe('listMessagesForSlave', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('refuses an unknown slave', async () => {
    const result = await listMessagesForSlave('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('slave_not_found')
  })

  it('never lists a message the slave itself sent', async () => {
    const { run, recipient, sender } = fixture
    await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    const senderInbox = await listMessagesForSlave(sender.id)
    expect(senderInbox.ok).toBe(true)
    if (senderInbox.ok) expect(senderInbox.value).toEqual([])
  })

  it('never lists its own role-broadcast, even though it holds the addressed role -- but a peer holding the same role sees it', async () => {
    const { run, sender } = fixture
    const senderRow = await prisma.slave.findUniqueOrThrow({ where: { id: sender.id } })
    const peer = await prisma.slave.create({
      data: { teamId: senderRow.teamId, name: 'Priya', role: 'Staff Engineer', runtimeRoles: [sender.role] },
    })

    const sent = await sendMessage(run.id, question({ recipientRole: sender.role }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    await parkAsWaiting(run.id)

    const ownInbox = await listMessagesForSlave(sender.id)
    expect(ownInbox.ok).toBe(true)
    if (ownInbox.ok) expect(ownInbox.value).toEqual([])

    const ownUnanswered = await listMessagesForSlave(sender.id, { unansweredOnly: true })
    expect(ownUnanswered.ok).toBe(true)
    if (ownUnanswered.ok) expect(ownUnanswered.value).toEqual([])

    const peerInbox = await listMessagesForSlave(peer.id)
    expect(peerInbox.ok).toBe(true)
    if (peerInbox.ok) expect(peerInbox.value.map((m) => m.id)).toEqual([sent.value.id])
  })

  it('unreadOnly excludes a message already marked read', async () => {
    const { run, recipient } = fixture
    const sent = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    await markMessageRead(sent.value.id, recipient.id)

    const unread = await listMessagesForSlave(recipient.id, { unreadOnly: true })
    expect(unread.ok).toBe(true)
    if (unread.ok) expect(unread.value).toEqual([])

    const all = await listMessagesForSlave(recipient.id)
    expect(all.ok).toBe(true)
    if (all.ok) expect(all.value).toHaveLength(1)
  })

  it('unansweredOnly excludes a question a reply has already landed for', async () => {
    const { run, recipient, sender } = fixture
    const opener = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(opener.ok).toBe(true)
    if (!opener.ok) return
    await parkAsWaiting(run.id)

    const beforeReply = await listMessagesForSlave(recipient.id, { unansweredOnly: true })
    expect(beforeReply.ok).toBe(true)
    if (beforeReply.ok) expect(beforeReply.value.map((m) => m.id)).toEqual([opener.value.id])

    const secondRun = await prisma.slaveRun.create({ data: { slaveId: recipient.id, status: 'working' } })
    await sendMessage(secondRun.id, {
      kind: 'answer',
      body: 'use the retry queue',
      recipientSlaveId: sender.id,
      replyToId: opener.value.id,
    })

    const afterReply = await listMessagesForSlave(recipient.id, { unansweredOnly: true })
    expect(afterReply.ok).toBe(true)
    if (afterReply.ok) expect(afterReply.value).toEqual([])
  })
})

describe('markMessageRead', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  it('sets readAt', async () => {
    const { run, recipient } = fixture
    const sent = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const result = await markMessageRead(sent.value.id, recipient.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.readAt).not.toBeNull()
  })

  it('is idempotent: marking an already-read message again succeeds and keeps the timestamp', async () => {
    const { run, recipient } = fixture
    const sent = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const first = await markMessageRead(sent.value.id, recipient.id)
    const second = await markMessageRead(sent.value.id, recipient.id)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.value.readAt).toBe(first.value.readAt)
  })

  it('refuses an unknown message', async () => {
    const { recipient } = fixture
    const result = await markMessageRead('00000000-0000-4000-8000-000000000000', recipient.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('message_not_found')
  })

  it('refuses an unknown slave', async () => {
    const { run, recipient } = fixture
    const sent = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const result = await markMessageRead(sent.value.id, '00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('slave_not_found')
  })

  it('refuses a slave the message is not addressed to', async () => {
    const { run, recipient, sender } = fixture
    const sent = await sendMessage(run.id, question({ recipientSlaveId: recipient.id }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const result = await markMessageRead(sent.value.id, sender.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('not_message_recipient')
  })

  it('refuses a slave in another workspace even when its role name matches the addressed role, and leaves readAt null', async () => {
    const { run, outsider } = fixture
    // `outsider` (fixture) holds the runtime role "answerer" too, in the SECOND workspace -- same
    // role name, different workspace. A bare string comparison of roles alone would wrongly admit
    // it.
    const sent = await sendMessage(run.id, question({ recipientRole: 'answerer' }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    const result = await markMessageRead(sent.value.id, outsider.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('not_message_recipient')

    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: sent.value.id } })
    expect(row.readAt).toBeNull()
  })
})

/**
 * M39 t2. Two verbs that move an EXISTING question rather than writing a new message: the
 * Supervisor answering one itself (`answerQuestion` with `origin: 'system'`), and re-addressing one
 * to somebody who can answer it.
 */
describe('answerQuestion -- who the answer comes from', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    fixture = await seed()
  })

  it('a human answer is a human row and a human event (unchanged, by default)', async () => {
    const questionId = await askAsRole(fixture)

    const result = await answerQuestion(questionId, { body: 'the retry queue', answeredBy: 'operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.actor).toBe('human')
    // The LAST one: the first `slave.message_sent` in this thread is the question itself.
    const sent = (await eventsOfType('slave_message_sent')).at(-1)
    expect(sent?.actor).toBe('human')
  })

  it('a Supervisor answer is a system row and a system event, and says who answered', async () => {
    const questionId = await askAsRole(fixture)

    const result = await answerQuestion(
      questionId,
      { body: 'the retry queue', answeredBy: 'supervisor' },
      'system',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: result.value.id } })
    // Everything else about the row is what a human's answer would be: the asker's thread, the
    // question as its parent, nobody waiting on IT.
    expect(row.actor).toBe('system')
    expect(row.kind).toBe('answer')
    expect(row.replyToId).toBe(questionId)
    expect(row.senderRunId).toBeNull()

    const sent = (await eventsOfType('slave_message_sent')).at(-1)
    expect(sent?.actor).toBe('system')
    expect(sent?.payload).toMatchObject({ kind: 'answer', answeredBy: 'supervisor' })
  })
})

describe('reassignQuestion', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    fixture = await seed()
  })

  it('moves a role-addressed question onto one worker, and announces both ends of the move', async () => {
    const questionId = await askAsRole(fixture)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')

    const result = await reassignQuestion(questionId, peer, 'operator')

    expect(result).toEqual({ ok: true, value: undefined })
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
    expect(row.recipientSlaveId).toBe(peer)
    // Cleared, not left beside the new recipient: exactly one of the two columns addresses a row.
    expect(row.recipientRole).toBeNull()

    const [moved] = await eventsOfType('slave_message_reassigned')
    expect(moved?.actor).toBe('human')
    expect(moved?.slaveId).toBe(fixture.sender.id)
    expect(moved?.payload).toEqual({
      messageId: questionId,
      decisionId: null,
      from: { role: 'answerer', slaveId: null },
      to: { slaveId: peer },
      actor: 'operator',
    })
  })

  it('the question leaves the old role holders inbox and lands in the new workers', async () => {
    const questionId = await askAsRole(fixture)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')
    expect((await inboxOf(fixture.recipient.id))).toEqual([questionId])

    expect((await reassignQuestion(questionId, peer, 'operator')).ok).toBe(true)

    expect(await inboxOf(fixture.recipient.id)).toEqual([])
    expect(await inboxOf(peer)).toEqual([questionId])
  })

  it('with origin system it is a system event naming the decision behind it', async () => {
    const questionId = await askAsRole(fixture)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')

    expect((await reassignQuestion(questionId, peer, 'supervisor', 'system', undefined, 'sd-1')).ok).toBe(true)

    const [moved] = await eventsOfType('slave_message_reassigned')
    expect(moved?.actor).toBe('system')
    expect(moved?.payload).toMatchObject({ decisionId: 'sd-1', actor: 'supervisor' })
  })

  it('moves a SLAVE-addressed question to a worker holding the role the asking task requires', async () => {
    const task = await taskRequiring(fixture, 'answerer')
    const questionId = await askDirectly(fixture, fixture.recipient.id, task)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')

    expect((await reassignQuestion(questionId, peer, 'operator')).ok).toBe(true)

    const [moved] = await eventsOfType('slave_message_reassigned')
    // The question came from a SLAVE, so that is the end the move is announced from.
    expect(moved?.payload).toMatchObject({ from: { role: null, slaveId: fixture.recipient.id } })
  })

  it('moves a slave-addressed question freely when the asking task requires no role at all', async () => {
    const questionId = await askDirectly(fixture, fixture.recipient.id, null)
    const anyone = await peerHolding(fixture, 'something-else', 'Zed')

    expect((await reassignQuestion(questionId, anyone, 'operator')).ok).toBe(true)
  })

  it('refuses a message id nobody wrote', async () => {
    const peer = await peerHolding(fixture, 'answerer', 'Zed')
    expect(await reassignQuestion('m-nope', peer, 'operator')).toEqual({
      ok: false,
      error: { kind: 'message_not_found', messageId: 'm-nope' },
    })
  })

  it('refuses a message that is not a question', async () => {
    const sent = await sendMessage(fixture.run.id, {
      kind: 'information',
      body: 'for your notes',
      recipientRole: 'answerer',
    })
    if (!sent.ok) throw new Error('the fixture could not send')
    const peer = await peerHolding(fixture, 'answerer', 'Zed')

    expect(await reassignQuestion(sent.value.id, peer, 'operator')).toEqual({
      ok: false,
      error: { kind: 'message_not_question', messageId: sent.value.id },
    })
  })

  it('refuses a question a reply has already landed for, and writes nothing', async () => {
    const questionId = await askAsRole(fixture)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')
    const answered = await answerQuestion(questionId, { body: 'over there', answeredBy: 'operator' })
    if (!answered.ok) throw new Error('the fixture could not answer')

    expect(await reassignQuestion(questionId, peer, 'operator')).toEqual({
      ok: false,
      error: { kind: 'question_answered', messageId: questionId },
    })
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
    expect(row.recipientRole).toBe('answerer')
    expect(row.recipientSlaveId).toBeNull()
    expect(await eventsOfType('slave_message_reassigned')).toHaveLength(0)
  })

  it('refuses a question whose asker has stopped waiting for an answer', async () => {
    const questionId = await askAsRole(fixture)
    const peer = await peerHolding(fixture, 'answerer', 'Zed')
    // Resumed by something other than its answer -- `orchestrator resume --run`, the panel's
    // fallback button. Nobody is parked on this question any more.
    await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'working', pauseReason: null } })

    expect(await reassignQuestion(questionId, peer, 'operator')).toEqual({
      ok: false,
      error: { kind: 'question_answered', messageId: questionId },
    })
  })

  it('settles the question BEFORE it looks at the worker: an answered question refuses first', async () => {
    // The order spec §4 lists, and it is the useful one: told "no such worker" about a question
    // that was already answered, an operator goes looking for the wrong problem.
    const questionId = await askAsRole(fixture)
    const answered = await answerQuestion(questionId, { body: 'over there', answeredBy: 'operator' })
    if (!answered.ok) throw new Error('the fixture could not answer')

    expect(await reassignQuestion(questionId, 'ag-nope', 'operator')).toEqual({
      ok: false,
      error: { kind: 'question_answered', messageId: questionId },
    })
  })

  it('refuses a worker nobody has, and one in another project (which reads back the same)', async () => {
    const questionId = await askAsRole(fixture)

    expect(await reassignQuestion(questionId, 'ag-nope', 'operator')).toEqual({
      ok: false,
      error: { kind: 'slave_not_found', slaveId: 'ag-nope' },
    })
    // Zoe holds `answerer` -- in the OTHER workspace, which is the whole point: a scoped caller
    // cannot tell her from a worker who does not exist.
    expect(await reassignQuestion(questionId, fixture.outsider.id, 'operator')).toEqual({
      ok: false,
      error: { kind: 'slave_not_found', slaveId: fixture.outsider.id },
    })
  })

  it('refuses a worker who does not hold the role the question was addressed to', async () => {
    const questionId = await askAsRole(fixture)
    const stranger = await peerHolding(fixture, 'frontend', 'Zed')

    const result = await reassignQuestion(questionId, stranger, 'operator')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: 'reassign_not_permitted',
      messageId: questionId,
      slaveId: stranger,
      reason: 'it does not hold the role the question was addressed to (answerer)',
    })
    const row = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
    expect(row.recipientSlaveId).toBeNull()
  })

  it('refuses a worker who does not hold the role the asking task requires', async () => {
    const task = await taskRequiring(fixture, 'answerer')
    const questionId = await askDirectly(fixture, fixture.recipient.id, task)
    const stranger = await peerHolding(fixture, 'frontend', 'Zed')

    const result = await reassignQuestion(questionId, stranger, 'operator')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({
      kind: 'reassign_not_permitted',
      reason: 'it does not hold the role the asking task requires (answerer)',
    })
  })

  it('refuses the asker itself, however many roles it holds', async () => {
    // The asker is given the addressed role too, so the ONLY thing standing in the way is that it
    // is the asker: a question re-addressed to whoever asked it is a loop nobody can close --
    // `answer.ts` refuses a slave its own question, and the asker stays parked forever.
    //
    // This clause now lives in the DOMAIN's `answerBar`, which this verb calls (final review
    // Important 3): the same function stamps a `reassign_question` routine, so there is no second
    // spelling of the rule that can disagree with this refusal. `policy.test.ts` covers the other
    // side of it.
    await prisma.slave.update({ where: { id: fixture.sender.id }, data: { runtimeRoles: ['asker', 'answerer'] } })
    const questionId = await askAsRole(fixture)

    const result = await reassignQuestion(questionId, fixture.sender.id, 'operator')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({
      kind: 'reassign_not_permitted',
      reason: 'it is the worker that asked the question',
    })
  })
})
