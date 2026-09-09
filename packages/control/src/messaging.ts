import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import {
  type MessageKind, type Result, type SlaveMessageView, err, isValidRecipient, ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
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
const namespacedKey = (verb: 'send' | 'answer', key: string): string => `${verb}:${key}`

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
  /** Only `question`s somebody is STILL waiting on -- see {@link stillPendingQuestion}. */
  readonly unansweredOnly?: boolean
}

/**
 * The one definition of "this question is still pending", shared by every reader of that set:
 * `listMessagesForSlave`'s `unansweredOnly` filter (which is what `apps/orchestrator/src/inbox.ts`
 * puts in a recipient's prompt), {@link listPendingQuestions} (the CLI's `messages` verb and the
 * web's answer box), and nothing else.
 *
 * Three conditions, and the third is the one the final review added. A question is pending while
 * it is a question that expects a reply, while no reply has landed -- and while THE ASKER IS STILL
 * WAITING FOR ONE. Without that last clause, a waiting run resumed by anything other than its
 * answer (`orchestrator resume --run`, the slave panel's fallback Resume button) left its question
 * matching forever: the asker was long since running, finished, or failed, and every subsequent run
 * of the recipient still opened with "another slave asked you this and cannot continue until you
 * reply". Worse, a recipient that eventually did reply wrote an answer `deliverAnswers` could never
 * deliver -- the asker was not `paused` any more -- so it sat with both timestamps null forever.
 *
 * "Still waiting" is exactly the state `ask.ts` parks a run in and `deliverAnswers` hunts for:
 * `paused` with `pauseReason = waiting_for_answer`. Expressed as a run-id set rather than a
 * relation filter because `SlaveMessage.senderRunId` deliberately carries no Prisma relation (see
 * its own doc comment: a second FK to `SlaveRun` would fight `slaveId`'s cascade). The set is one
 * indexed read of the waiting runs in one workspace -- usually none.
 */
async function waitingSenderRunIds(workspaceId: string): Promise<string[]> {
  const runs = await prisma.slaveRun.findMany({
    where: { status: 'paused', pauseReason: 'waiting_for_answer', slave: { team: { workspaceId } } },
    select: { id: true },
  })
  return runs.map((run) => run.id)
}

/** The `where` fragment {@link waitingSenderRunIds} feeds. A question whose `senderRunId` is null
 *  (no run ever asked it) can park nobody and is never pending. */
function stillPendingQuestion(waitingRunIds: string[]): {
  kind: 'question'
  expectsReply: true
  replies: { none: Record<string, never> }
  senderRunId: { in: string[] }
} {
  return {
    kind: 'question' as const,
    expectsReply: true as const,
    replies: { none: {} },
    senderRunId: { in: waitingRunIds },
  }
}

/** Every message addressed to `slaveId` -- directly, or by every RUNTIME role it currently holds -- in
 *  its own workspace, oldest first (thread order, not wall-clock order: see `seq` on the schema).
 *  Never messages this slave SENT; only ones addressed TO it. */
export async function listMessagesForSlave(
  slaveId: string,
  filter: ListMessagesFilter = {},
): Promise<Result<readonly SlaveMessageView[], ControlRefusal>> {
  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, include: { team: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  const waitingRunIds =
    filter.unansweredOnly === true ? await waitingSenderRunIds(slave.team.workspaceId) : []

  const rows = await prisma.slaveMessage.findMany({
    where: {
      workspaceId: slave.team.workspaceId,
      // Never a message this slave itself SENT (own doc comment above): without this, a slave
      // that role-broadcasts to its own role would see its own question in its own inbox --
      // `recipientRole: slave.role` alone does not know who sent a row, only who it is addressed
      // to (fix round 1, Important finding 2).
      slaveId: { not: slaveId },
      // Role addressing is `runtimeRoles`, not `role` (M37 §5): `Slave.role` is the profile's
      // title, and addressing "the reviewer" has to reach whoever may actually be dispatched as
      // one. `in` rather than an equality, because a slave holds a SET of them -- and a slave with
      // an empty set is reachable by name only, which is the same "cannot be dispatched" state the
      // scheduler reads it as.
      OR: [{ recipientSlaveId: slaveId }, { recipientRole: { in: [...slave.runtimeRoles] } }],
      ...(filter.unreadOnly === true ? { readAt: null } : {}),
      ...(filter.unansweredOnly === true ? stillPendingQuestion(waitingRunIds) : {}),
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
    prisma.slave.findUnique({ where: { id: slaveId }, include: { team: true } }),
  ])
  if (message === null) return err({ kind: 'message_not_found', messageId })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  // Scope BEFORE the direct/role check (fix round 1, Important finding 1): `addressedByRole`
  // below compares bare role-name strings, which say nothing about which workspace either side
  // is in -- a slave in workspace B whose role happens to match a role-addressed message's
  // `recipientRole` in workspace A must not be able to mark it read, the same boundary
  // `sendMessage` already enforces on write.
  if (message.workspaceId !== slave.team.workspaceId) {
    return err({ kind: 'not_message_recipient', messageId, slaveId })
  }

  const addressedDirectly = message.recipientSlaveId === slaveId
  // `runtimeRoles`, not `role` (M37 §5) -- and the same set `listMessagesForSlave` builds this
  // slave's inbox from, so a message it was shown is a message it may mark read.
  const addressedByRole = message.recipientRole !== null && slave.runtimeRoles.includes(message.recipientRole)
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

export interface AnswerQuestionInput {
  readonly body: string
  /** Who answered, for the event's own record. The CLI passes the operator's name. */
  readonly answeredBy: string
  /**
   * Replaying the same key returns the first call's message, unwritten a second time. Defaults to
   * a key derived from the question and the answer TEXT, so the ordinary operator replay -- the
   * same command run twice, a retried request -- writes one row, while an operator who genuinely
   * says something different writes a second.
   */
  readonly idempotencyKey?: string
  readonly principal?: Principal
}

/**
 * Answers a worker's question as a HUMAN (M36 t3) -- the operator's way to unstick a project with
 * no second worker to hand.
 *
 * The worker path is `sendMessage(runId, { kind: 'answer', replyToId })`, which derives its sender
 * from the run. A human has no run, so this is a separate verb rather than a nullable-run branch
 * inside that one: everything a `sendMessage` refusal is about (an unknown run, a recipient the
 * sender may not address, a reply target outside the sender's workspace) is decided from the
 * SENDER's scope, and there is no sender here to scope by. What replaces that scope is the
 * question itself: the answer is written into the question's own workspace, thread and task, so
 * there is no workspace boundary for it to cross.
 *
 * **Whose row this is.** `SlaveMessage.slaveId` is NOT NULL, and for a human-authored row it has
 * meant the slave the human ADDRESSED since long before M36 -- it is what the web's communication
 * fold reads to draw `operator -> slave` for every `actor: 'human'` message. So it holds the
 * ASKER: the one this answer is for, and the one who will be resumed by it. `senderRunId` stays
 * null (no run wrote it) and `actor` is `human`, which together are what tell this row apart from
 * a worker's answer.
 *
 * Delivery is deliberately NOT here: this writes the answer, and `deliverAnswers`
 * (`apps/orchestrator/src/deliver.ts`) is the one place that decides whether a waiting run may be
 * resumed by it. Control does not spawn children, and a resume that no process is standing behind
 * is the orphan shape the sweep exists to destroy.
 */
export async function answerQuestion(
  questionId: string,
  input: AnswerQuestionInput,
): Promise<Result<SlaveMessageView, ControlRefusal>> {
  if (input.body.trim() === '') return err({ kind: 'invalid_message_body' })

  const question = await prisma.slaveMessage.findUnique({ where: { id: questionId } })
  if (question === null) return err({ kind: 'message_not_found', messageId: questionId })
  if (question.kind !== 'question') {
    return err({ kind: 'not_a_question', messageId: questionId, messageKind: question.kind })
  }

  const workspaceId = question.workspaceId
  const generatedId = randomUUID()
  const key = namespacedKey(
    'answer',
    input.idempotencyKey ?? `human:${questionId}:${createHash('sha256').update(input.body).digest('hex').slice(0, 16)}`,
  )

  const outcome = await prisma.$transaction(
    async (tx) => {
      // The same workspace lock `sendMessage` takes, for the same reason: the idempotency replay
      // has to observe (and, on a miss, close) the window a concurrent answer with the same key
      // would also open.
      await tx.$queryRaw`SELECT 1 FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`

      const seen = await tx.slaveMessage.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key } },
      })
      if (seen !== null) return { replayed: true as const, row: seen }

      const row = await tx.slaveMessage.create({
        data: {
          id: generatedId,
          taskId: question.taskId,
          // The asker, twice: as the slave this human addressed (`slaveId`, the pre-M36 convention
          // for a human-authored row) and as the recipient in M36's own columns.
          slaveId: question.slaveId,
          recipientSlaveId: question.slaveId,
          recipientRole: null,
          workspaceId,
          senderRunId: null,
          threadId: question.threadId,
          replyToId: question.id,
          kind: 'answer',
          body: input.body,
          actor: 'human',
          expectsReply: false,
          idempotencyKey: key,
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
      taskId: question.taskId,
      slaveId: question.slaveId,
      actor: 'human',
      payload: {
        messageId: outcome.row.id,
        kind: 'answer',
        body: outcome.row.body,
        threadId: outcome.row.threadId,
        replyToId: outcome.row.replyToId,
        recipientSlaveId: outcome.row.recipientSlaveId,
        recipientRole: null,
        expectsReply: false,
        answeredBy: input.answeredBy,
      },
      userId: input.principal?.userId ?? null,
    })
  }

  return ok(toView(outcome.row))
}

/**
 * Every question in a workspace that is still waiting for a reply (M36 t3), oldest first.
 *
 * The operator's read side for `answerQuestion`: a human answering needs the message id, and the
 * id lives nowhere an operator can see it otherwise. Workspace-scoped rather than slave-scoped
 * (`listMessagesForSlave` is the worker's own inbox) because the operator is answering ON BEHALF
 * of whoever was addressed -- including a role nobody free is holding, which is exactly the
 * situation this verb exists for.
 *
 * "Still waiting for a reply" is {@link stillPendingQuestion}'s definition, shared with the inbox a
 * recipient's prompt is built from, so an operator's `messages` list and a worker's inbox can never
 * disagree about which questions are open.
 */
export async function listPendingQuestions(
  workspaceId: string,
): Promise<Result<readonly SlaveMessageView[], ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const rows = await prisma.slaveMessage.findMany({
    where: { workspaceId, ...stillPendingQuestion(await waitingSenderRunIds(workspaceId)) },
    orderBy: { seq: 'asc' },
  })
  return ok(rows.map(toView))
}
