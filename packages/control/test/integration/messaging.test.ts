import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listMessagesForSlave, markMessageRead, sendMessage, type SendMessageInput,
} from '../../src/messaging.js'

interface Fixture {
  readonly workspace: { readonly id: string }
  readonly otherWorkspace: { readonly id: string }
  readonly sender: { readonly id: string; readonly role: string }
  readonly recipient: { readonly id: string; readonly role: string }
  readonly outsider: { readonly id: string }
  readonly run: { readonly id: string }
}

/**
 * One workspace with a sender and a named recipient (roles "asker"/"answerer" so the role-based
 * addressing tests are unambiguous), a run that sender is mid-way through, and one slave in a
 * SECOND workspace for the cross-workspace refusal.
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

  const sender = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'asker' } })
  const recipient = await prisma.slave.create({ data: { teamId: team.id, name: 'Maya', role: 'answerer' } })
  const outsider = await prisma.slave.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'answerer' } })

  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: sender.id, status: 'working' } })

  return {
    workspace: { id: workspace.id },
    otherWorkspace: { id: otherWorkspace.id },
    sender: { id: sender.id, role: sender.role },
    recipient: { id: recipient.id, role: recipient.role },
    outsider: { id: outsider.id },
    run: { id: run.id },
  }
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
      data: { teamId: senderRow.teamId, name: 'Priya', role: sender.role },
    })

    const sent = await sendMessage(run.id, question({ recipientRole: sender.role }))
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

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
    // `outsider` (fixture) holds the role "answerer" too, in the SECOND workspace -- same role
    // name, different workspace. A bare string comparison of roles alone would wrongly admit it.
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
