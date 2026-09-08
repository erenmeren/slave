import { randomUUID } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import {
  type MessageKind, type Result, type SlaveMessageView, err, isValidRecipient, ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { ControlRefusal } from './refusal.js'

const SEND_TIMEOUT_MS = 5_000
const SEND_MAX_WAIT_MS = 2_000

/**
 * `sendMessage`'s idempotency key, namespaced by verb -- the same idiom
 * `packages/control/src/simulation/shared.ts`'s `namespacedKey` follows for `step`/`inject`/
 * `adopt` sharing one column on `SimulationJournalEntry`. `SlaveMessage.idempotencyKey` will be
 * shared by this task's `send` and Task 3's `answer`; the prefix is what keeps the two verbs'
 * keys from colliding on a coincidentally-equal caller-supplied string.
 */
const namespacedKey = (verb: 'send', key: string): string => `${verb}:${key}`

export interface SendMessageInput {
  readonly kind: MessageKind
  readonly body: string
  /** A named worker to address, or `null`/absent. Exactly one of this and `recipientRole` must
   *  be set -- see `isValidRecipient` (`@slave-of-ai/domain`). */
  readonly recipientSlaveId?: string | null
  /** Every worker currently holding this role, or `null`/absent. */
  readonly recipientRole?: string | null
  /**
   * Starts (or continues) a thread with an explicit id, when the caller has one already and is
   * not replying to a specific message (e.g. a follow-up `information` in an ongoing exchange).
   * Ignored when `replyToId` is set -- a reply always inherits its parent's `threadId`, never a
   * caller-supplied one, so the two can never disagree. Omitted (and no `replyToId`) starts a
   * brand new thread.
   */
  readonly threadId?: string | null
  /** The message this one replies to. Must name a message in the SENDER's own workspace, or the
   *  send is refused as `message_not_found` -- a reply target in another workspace is invisible
   *  to a scoped caller, the same as one that never existed. */
  readonly replyToId?: string | null
  /** Whether the sender expects a reply. Defaults to `false`; M36 t2 sets this `true` for a
   *  worker's `question`. */
  readonly expectsReply?: boolean
  readonly taskId?: string | null
  /** Replaying the same key against the same run returns the first call's message, unwritten a
   *  second time. Omitted entirely, every send is distinct. */
  readonly idempotencyKey?: string
}

interface LoadedSender {
  readonly slaveId: string
  readonly workspaceId: string
}

async function loadSender(runId: string): Promise<Result<LoadedSender, ControlRefusal>> {
  // Scoped through `slave -> team`, the same derivation `pause.ts`/`dependency.ts` already make:
  // it is the only linkage a task-less (`planning`) run has to a workspace, and it is also just
  // correct for every other run kind.
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    include: { slave: { include: { team: true } } },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })
  return ok({ slaveId: run.slave.id, workspaceId: run.slave.team.workspaceId })
}

function toView(row: {
  id: string
  taskId: string | null
  workspaceId: string
  threadId: string
  replyToId: string | null
  slaveId: string
  senderRunId: string | null
  recipientSlaveId: string | null
  recipientRole: string | null
  kind: string
  body: string
  expectsReply: boolean
  readAt: Date | null
  createdAt: Date
}): SlaveMessageView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    taskId: row.taskId,
    threadId: row.threadId,
    replyToId: row.replyToId,
    senderSlaveId: row.slaveId,
    senderRunId: row.senderRunId,
    recipientSlaveId: row.recipientSlaveId,
    recipientRole: row.recipientRole,
    kind: row.kind as MessageKind,
    body: row.body,
    expectsReply: row.expectsReply,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Sends a durable, scoped message from the RUN's own slave -- never from `input`, which carries
 * no sender field at all, so a model that names someone else as sender has nothing to name it
 * with. Every read and write below is confined to the run's own workspace; a named recipient
 * outside it is refused as `cross_workspace` before anything is written.
 *
 * Refusals that need no write (an unknown run, a malformed recipient, an unknown or
 * cross-workspace recipient or reply target) are returned before the transaction opens -- nothing
 * has been claimed yet, so there is nothing to roll back. The transaction itself exists for
 * exactly one thing: the idempotency replay must observe (and, on a miss, close) the same
 * `SELECT ... FOR UPDATE`-locked window a concurrent send with the same key would also open,
 * the same discipline `dependency.ts` follows for its own workspace-scoped writes.
 */
export async function sendMessage(
  runId: string,
  input: SendMessageInput,
): Promise<Result<SlaveMessageView, ControlRefusal>> {
  if (input.body.trim() === '') return err({ kind: 'invalid_message_body' })

  const recipientSlaveId = input.recipientSlaveId ?? null
  const recipientRole = input.recipientRole ?? null
  if (!isValidRecipient({ slaveId: recipientSlaveId, role: recipientRole })) {
    return err({
      kind: 'invalid_recipient',
      detail: 'exactly one of recipientSlaveId or recipientRole must be set',
    })
  }

  const sender = await loadSender(runId)
  if (!sender.ok) return sender
  const { slaveId: senderSlaveId, workspaceId } = sender.value

  if (recipientSlaveId !== null) {
    const recipient = await prisma.slave.findUnique({
      where: { id: recipientSlaveId },
      include: { team: true },
    })
    if (recipient === null) return err({ kind: 'slave_not_found', slaveId: recipientSlaveId })
    if (recipient.team.workspaceId !== workspaceId) {
      return err({ kind: 'cross_workspace', runId, recipientSlaveId })
    }
  }

  // A reply's `threadId` always comes from its parent, never from the caller (see the field's own
  // doc comment on `SendMessageInput`) -- and the lookup is scoped to this run's own workspace, so
  // a `replyToId` naming a real message in a DIFFERENT workspace reads back exactly like one that
  // does not exist at all, the same boundary `sendMessage`'s recipient check enforces the other
  // direction.
  let threadId = input.threadId ?? null
  if (input.replyToId !== undefined && input.replyToId !== null) {
    const parent = await prisma.slaveMessage.findFirst({
      where: { id: input.replyToId, workspaceId },
      select: { threadId: true },
    })
    if (parent === null) return err({ kind: 'message_not_found', messageId: input.replyToId })
    threadId = parent.threadId
  }

  const generatedId = randomUUID()
  const replyToId = input.replyToId ?? null
  const expectsReply = input.expectsReply ?? false
  const taskId = input.taskId ?? null

  const outcome = await prisma.$transaction(
    async (tx) => {
      // The smallest lock every concurrent send in this workspace shares -- the same idiom
      // `dependency.ts` uses to serialise a workspace-scoped read-then-write against itself.
      await tx.$queryRaw`SELECT 1 FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`

      if (input.idempotencyKey !== undefined) {
        const key = namespacedKey('send', input.idempotencyKey)
        const seen = await tx.slaveMessage.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key } },
        })
        if (seen !== null) return { replayed: true as const, row: seen }
      }

      const row = await tx.slaveMessage.create({
        data: {
          id: generatedId,
          taskId,
          slaveId: senderSlaveId,
          workspaceId,
          senderRunId: runId,
          recipientSlaveId,
          recipientRole,
          threadId: threadId ?? generatedId,
          replyToId,
          kind: input.kind,
          body: input.body,
          actor: 'slave',
          expectsReply,
          idempotencyKey: input.idempotencyKey !== undefined ? namespacedKey('send', input.idempotencyKey) : null,
        },
      })
      return { replayed: false as const, row }
    },
    { timeout: SEND_TIMEOUT_MS, maxWait: SEND_MAX_WAIT_MS },
  )

  if (!outcome.replayed) {
    await appendEvent({
      type: 'slave.message_sent',
      workspaceId,
      taskId,
      slaveId: senderSlaveId,
      runId,
      actor: 'slave',
      payload: {
        messageId: outcome.row.id,
        kind: outcome.row.kind,
        body: outcome.row.body,
        threadId: outcome.row.threadId,
        replyToId: outcome.row.replyToId,
        recipientSlaveId: outcome.row.recipientSlaveId,
        recipientRole: outcome.row.recipientRole,
        expectsReply: outcome.row.expectsReply,
      },
    })
  }

  return ok(toView(outcome.row))
}

export interface ListMessagesFilter {
  /** Only messages with no `readAt` yet. */
  readonly unreadOnly?: boolean
  /** Only `question`s that expect a reply and have none in their thread yet -- `kind: 'question'`,
   *  `expectsReply: true`, and no `SlaveMessage` row replies to it. */
  readonly unansweredOnly?: boolean
}

/** Every message addressed to `slaveId` -- directly, or by every role it currently holds -- in
 *  its own workspace, oldest first (thread order, not wall-clock order: see `seq` on the schema).
 *  Never messages this slave SENT; only ones addressed TO it. */
export async function listMessagesForSlave(
  slaveId: string,
  filter: ListMessagesFilter = {},
): Promise<Result<readonly SlaveMessageView[], ControlRefusal>> {
  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, include: { team: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  const rows = await prisma.slaveMessage.findMany({
    where: {
      workspaceId: slave.team.workspaceId,
      OR: [{ recipientSlaveId: slaveId }, { recipientRole: slave.role }],
      ...(filter.unreadOnly === true ? { readAt: null } : {}),
      ...(filter.unansweredOnly === true
        ? { kind: 'question' as const, expectsReply: true, replies: { none: {} } }
        : {}),
    },
    orderBy: { seq: 'asc' },
  })

  return ok(rows.map(toView))
}

/** Marks one message read by the slave it is addressed to. Idempotent: marking an
 *  already-read message again is a no-op success, not a refusal. */
export async function markMessageRead(
  messageId: string,
  slaveId: string,
): Promise<Result<SlaveMessageView, ControlRefusal>> {
  const [message, slave] = await Promise.all([
    prisma.slaveMessage.findUnique({ where: { id: messageId } }),
    prisma.slave.findUnique({ where: { id: slaveId } }),
  ])
  if (message === null) return err({ kind: 'message_not_found', messageId })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  const addressedDirectly = message.recipientSlaveId === slaveId
  const addressedByRole = message.recipientRole !== null && message.recipientRole === slave.role
  if (!addressedDirectly && !addressedByRole) {
    return err({ kind: 'not_message_recipient', messageId, slaveId })
  }

  if (message.readAt !== null) return ok(toView(message))

  const updated = await prisma.slaveMessage.update({
    where: { id: messageId },
    data: { readAt: new Date() },
  })
  return ok(toView(updated))
}
