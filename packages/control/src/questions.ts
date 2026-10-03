import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CLOSED_BY_OPERATOR,
  CLOSED_BY_SYSTEM,
  CLOSED_NOTE_MAX_CHARS,
  LATE_ANSWER_NOTE,
  QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS,
  QUESTION_SITUATION_KINDS,
  TERMINAL,
  closerWords,
  handOffRoute,
  runContinuedPast,
  storableText,
  trimToFit,
  type LateAnswerFate,
  type QuestionCloseReason,
  type TaskStatus,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Human-cards spec H1: a question closes once, and a closed question is pending nowhere. Every close
 * goes through {@link closeQuestionIn}, a conditional write, so two closers race to one winner (plan
 * A D1). The event is appended after the commit ({@link announceQuestionClosed}): `appendEvent` owns
 * its own transaction.
 */

export interface CloseQuestionInput {
  readonly messageId: string
  readonly reason: QuestionCloseReason
  /** A user id, `operator`, or `system` ({@link closedByOf}). */
  readonly by: string
  /** What the asker continues with; null for `answered`. */
  readonly note: string | null
  /** The card the close came from, when it came from one. */
  readonly decisionId: string | null
}

/** `closedBy` for a person's act: their user id, or `operator` when no account can be named. */
export function closedByOf(principal: Principal | undefined): string {
  return principal?.userId ?? CLOSED_BY_OPERATOR
}

/** Closes an open question inside `tx`; false when it was already closed (or is not a question). */
export async function closeQuestionIn(tx: Prisma.TransactionClient, input: CloseQuestionInput, now: Date): Promise<boolean> {
  const closed = await tx.slaveMessage.updateMany({
    where: { id: input.messageId, kind: 'question', closedAt: null },
    data: {
      closedAt: now,
      closedReason: input.reason,
      closedBy: input.by,
      closedNote: input.note === null ? null : trimToFit(storableText(input.note), CLOSED_NOTE_MAX_CHARS),
      timeoutRefusal: null,
    },
  })
  return closed.count === 1
}

/** Plan A D11: the close's one event, after the commit that closed it. */
export async function announceQuestionClosed(
  question: { readonly workspaceId: string; readonly taskId: string | null; readonly slaveId: string },
  input: CloseQuestionInput,
  actor: 'human' | 'system',
  userId: string | null,
): Promise<void> {
  await appendEvent({
    type: 'slave.question_closed',
    workspaceId: question.workspaceId,
    taskId: question.taskId,
    slaveId: question.slaveId,
    actor,
    payload: {
      messageId: input.messageId,
      reason: input.reason,
      by: input.by,
      decisionId: input.decisionId,
      note: input.note === null ? null : trimToFit(storableText(input.note), QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS),
    },
    userId,
  })
}

/** The question a card is about, as a verdict reads it under the lock. */
export interface CardQuestion {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string | null
  readonly slaveId: string
  readonly body: string
  readonly createdAt: Date
  readonly closedAt: Date | null
  readonly closedReason: QuestionCloseReason | null
  readonly closedBy: string | null
  /** The asking task is not done, failed or cancelled (a question with no task counts as live). */
  readonly askerTaskLive: boolean
  /** The asking run is paused `waiting_for_answer`. */
  readonly askerParked: boolean
}

/**
 * The one question lock (final wave, finding 9): the Workspace row first (`recordDecision`'s,
 * `sendMessage`'s and `answerQuestion`'s lock, so no card is recorded and no answer lands between
 * the read and the close), then the question row (`claimTheAnswer`'s). Never the reverse: every
 * close path -- a card verdict, an expiry, {@link closeQuestion}, an answer -- takes it this way.
 * Taking it again inside a transaction that already holds the Workspace row is a no-op re-lock.
 * Null when the message is gone or is not a question.
 */
export async function lockCardQuestion(tx: Prisma.TransactionClient, workspaceId: string, messageId: string): Promise<CardQuestion | null> {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
  await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${messageId} FOR UPDATE`
  const message = await tx.slaveMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      taskId: true,
      slaveId: true,
      senderRunId: true,
      body: true,
      createdAt: true,
      closedAt: true,
      closedReason: true,
      closedBy: true,
      task: { select: { status: true } },
    },
  })
  if (message === null || message.kind !== 'question') return null
  const asker = message.senderRunId === null ? null : await tx.slaveRun.findUnique({ where: { id: message.senderRunId }, select: { status: true, pauseReason: true } })
  return {
    id: message.id,
    workspaceId: message.workspaceId,
    taskId: message.taskId,
    slaveId: message.slaveId,
    body: message.body,
    createdAt: message.createdAt,
    closedAt: message.closedAt,
    closedReason: message.closedReason,
    closedBy: message.closedBy,
    askerTaskLive: message.task === null || !TERMINAL.includes(message.task.status),
    askerParked: asker?.status === 'paused' && asker.pauseReason === 'waiting_for_answer',
  }
}

/**
 * Closes one question on its own (a card verb, an expiry, a timeout): the question is locked by
 * {@link lockCardQuestion} (Workspace, then the question row), the note is built from the question
 * as stored, and the event follows the commit. True when this call closed it.
 */
export async function closeQuestion(
  input: Omit<CloseQuestionInput, 'note'> & { readonly note: (question: { readonly body: string; readonly createdAt: Date }) => string | null },
  actor: 'human' | 'system',
  userId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  // The workspace is read unlocked to know which row to lock first: a message never changes workspace.
  const where = await prisma.slaveMessage.findUnique({ where: { id: input.messageId }, select: { workspaceId: true } })
  if (where === null) return false
  const outcome = await prisma.$transaction(async (tx) => {
    const question = await lockCardQuestion(tx, where.workspaceId, input.messageId)
    if (question === null) return null
    const close: CloseQuestionInput = { ...input, note: input.note(question) }
    return (await closeQuestionIn(tx, close, now)) ? { question, close } : null
  })
  if (outcome === null) return false
  await announceQuestionClosed(outcome.question, outcome.close, actor, userId)
  return true
}

/**
 * Plan A D5: expires every pending card about one question -- of any question kind -- except
 * `except` (the card being resolved). Each row is claimed conditionally, so a person resolving one in
 * the same instant wins it. Expired, not rejected: nobody decided against the card.
 */
export async function retireQuestionCards(workspaceId: string, messageId: string, reason: string, now: Date, except: string | null = null): Promise<number> {
  const open = await prisma.supervisorDecision.findMany({
    where: { workspaceId, subjectId: messageId, situationKind: { in: [...QUESTION_SITUATION_KINDS] }, status: 'pending', ...(except === null ? {} : { id: { not: except } }) },
    select: { id: true },
  })
  let retired = 0
  for (const row of open) {
    const claimed = await prisma.supervisorDecision.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'expired', resolvedAt: now } })
    if (claimed.count === 0) continue
    retired += 1
    await appendEvent({ type: 'supervisor.resolved', workspaceId, actor: 'system', payload: { decisionId: row.id, outcome: 'expired', reason } })
  }
  return retired
}

/** The words a retired card's event gives, by how its question closed. */
const RETIRED_BECAUSE: Readonly<Record<QuestionCloseReason, string>> = {
  answered: 'The question was answered.',
  decided: 'A person decided the question on another card.',
  dismissed: 'A person closed the question without an answer.',
  timed_out: 'The asking run continued without an answer.',
  superseded: 'A new goal version superseded the question.',
}

/**
 * Task 7 fix round 1: where a late answer to this question goes ({@link LateAnswerFate}), read from
 * the asking task -- on `tx` when the caller holds the question's lock. A package task: a hand-off
 * only where routing really delivers it to a run of the package -- `handOffRoute` says `delivered`
 * (final wave round 2, finding I5: the rule `routeHandOffs` stores the row by, so the card and the
 * routing cannot disagree). A task outside any package that has not finished: its next run's inbox.
 * Anything else nobody reads: a finished task, no task at all (a task-less planning run has no next
 * run on anything), or a package whose version is accepted (merged or not), abandoned, verifying or
 * waiting on a person, has no delivery, or whose task cannot take it (a conductor question).
 */
export async function lateAnswerFate(client: Prisma.TransactionClient, questionId: string): Promise<LateAnswerFate> {
  const question = await client.slaveMessage.findUnique({
    where: { id: questionId },
    select: { workspaceId: true, task: { select: { workPackageId: true, status: true, workPackage: { select: { goalVersion: true } } } } },
  })
  const task = question?.task ?? null
  const version = task?.workPackage?.goalVersion
  const delivery =
    question === null || version === undefined
      ? null
      : await client.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId: question.workspaceId, goalVersion: version } }, select: { status: true } })
  return lateAnswerFateOf(task, delivery?.status ?? null)
}

/** {@link lateAnswerFate}'s rule on an asking task already read, so a page of cards reads it in its
 *  own query rather than one per card. `deliveryStatus`: the status of the task's package's goal
 *  version's delivery, or null when it has none -- then the goal pass, which is what routes a late
 *  answer (`routeLateAnswers`), never runs for it. */
export function lateAnswerFateOf(task: { readonly workPackageId: string | null; readonly status: TaskStatus } | null, deliveryStatus: string | null): LateAnswerFate {
  if (task === null) return 'unread'
  if (task.workPackageId !== null) return deliveryStatus !== null && handOffRoute(deliveryStatus, task.status) === 'delivered' ? 'hand_off' : 'unread'
  return TERMINAL.includes(task.status) ? 'unread' : 'next_run'
}

/**
 * The reason an answered question's cards are retired with, or null when they must stay open. An
 * answer on time: answered. A late one (the question closed `timed_out`): where it goes, by
 * {@link lateAnswerFate} -- and nowhere means the card stays open, saying so (Task 7 fix round 1:
 * "answered" there would tell the person it was acted on).
 */
export async function answeredRetireReason(client: Prisma.TransactionClient, questionId: string, closedReason: QuestionCloseReason | null): Promise<string | null> {
  if (closedReason !== 'timed_out') return RETIRED_BECAUSE.answered
  const fate = await lateAnswerFate(client, questionId)
  return fate === 'unread' ? null : LATE_ANSWER_NOTE[fate]
}

/**
 * Final wave, finding 1: what an answer may do to the question it replies to, read under
 * {@link lockCardQuestion}. Plan A D6: a question a person decided, dismissed or superseded takes no
 * answer (`refused`); an `answered` one takes a second answer, and a `timed_out` one a late answer
 * (`open`, either way). `not_a_question`: the reply is to some other message, and closes nothing.
 * Every caller reads this before its first write, so returning the refusal commits nothing.
 */
export type AnswerGate =
  | { readonly kind: 'refused'; readonly refusal: ControlRefusal }
  | { readonly kind: 'open'; readonly question: CardQuestion }
  | { readonly kind: 'not_a_question' }

export async function gateAnswerIn(tx: Prisma.TransactionClient, workspaceId: string, messageId: string): Promise<AnswerGate> {
  const question = await lockCardQuestion(tx, workspaceId, messageId)
  if (question === null) return { kind: 'not_a_question' }
  const { closedAt, closedReason } = question
  if (closedAt !== null && closedReason !== null && closedReason !== 'answered' && closedReason !== 'timed_out') {
    return { kind: 'refused', refusal: { kind: 'question_closed', messageId, reason: closedReason, by: question.closedBy ?? CLOSED_BY_SYSTEM, at: closedAt.toISOString() } }
  }
  return { kind: 'open', question }
}

/** An answer's close, made in the answer's transaction and finished by {@link afterAnswered}. */
export interface AnsweredClose {
  readonly question: CardQuestion
  /** The close this answer made; null when the question was closed already (a second or a late answer). */
  readonly close: CloseQuestionInput | null
  /** {@link answeredRetireReason}: null keeps the question's cards open. */
  readonly retireReason: string | null
}

/**
 * Inside the answer's transaction, after the answer row: closes the question `answered` (`by`: who
 * answered, `system` for a worker) and reads, under the same lock, what its cards are retired with.
 * One rule for every answer -- a person's, the Supervisor's, a worker's.
 */
export async function closeAnsweredIn(tx: Prisma.TransactionClient, gate: { readonly question: CardQuestion }, by: string, now: Date): Promise<AnsweredClose> {
  const close: CloseQuestionInput = { messageId: gate.question.id, reason: 'answered', by, note: null, decisionId: null }
  const closed = await closeQuestionIn(tx, close, now)
  const retireReason = await answeredRetireReason(tx, gate.question.id, gate.question.closedReason)
  return { question: gate.question, close: closed ? close : null, retireReason }
}

/**
 * After the answer's commit: the close's one event, then every open card about the question retired
 * (plan A D5) -- or kept open, when no run will read a late answer. The retirement is said and
 * swallowed: the answer is out, and the tick's backstop retires what this missed.
 */
export async function afterAnswered(answered: AnsweredClose, actor: 'human' | 'system', userId: string | null, now: Date = new Date()): Promise<void> {
  if (answered.close !== null) await announceQuestionClosed(answered.question, answered.close, actor, userId)
  try {
    if (answered.retireReason !== null) await retireQuestionCards(answered.question.workspaceId, answered.question.id, answered.retireReason, now)
  } catch (error) {
    console.error(`[messaging] question ${answered.question.id}: its open cards were not retired:`, error)
  }
}

/**
 * Plan A D5, the tick's backstop: every pending question card whose question is closed for any
 * reason but `timed_out` (whose card stays open, spec H3) is retired. Ruling F7: a `timed_out`
 * question that has since taken a late answer is settled too, with the reason
 * {@link answeredRetireReason} gives -- unless no run will ever read that answer, when the card stays
 * open (Task 7 fix round 1). One query, and nothing else when there is nothing to retire.
 */
export async function retireClosedQuestionCards(workspaceId: string, now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ messageId: string; reason: QuestionCloseReason }[]>`
    SELECT DISTINCT d."subjectId" AS "messageId", m."closedReason"::text AS reason
    FROM "SupervisorDecision" d
    JOIN "SlaveMessage" m ON m.id = d."subjectId"
    WHERE d."workspaceId" = ${workspaceId}
      AND d.status = 'pending'
      AND d."situationKind" IN ('waiting_stale', 'unanswerable_question', 'conductor_question')
      AND m."closedAt" IS NOT NULL
      AND (
        m."closedReason" <> 'timed_out'
        OR EXISTS (SELECT 1 FROM "SlaveMessage" a WHERE a."replyToId" = m.id AND a.kind = 'answer')
      )`
  let retired = 0
  for (const row of rows) {
    const reason = row.reason === 'timed_out' ? await answeredRetireReason(prisma, row.messageId, row.reason) : RETIRED_BECAUSE[row.reason]
    if (reason !== null) retired += await retireQuestionCards(workspaceId, row.messageId, reason, now)
  }
  return retired
}

/**
 * Human cards plan A D13: what a card on a question shows of it. Plan B adds the version's packages
 * and the decisions the card offers.
 */
export interface QuestionCard {
  readonly messageId: string
  readonly body: string
  readonly goalVersion: number | null
  readonly askerPackageKey: string | null
  /** The run that asked (`senderRunId`): plan B routes a person's hand-off from it. */
  readonly askerRunId: string | null
  /** The asking run is still parked on this question (`deliverToOneRun`'s match). */
  readonly askerWaiting: boolean
  /** `by` is the stored `closedBy`; `byName` is what a person reads -- a user's name, "the system"
   *  or "an operator" (Task 4 carry: a card never shows a raw user id). */
  readonly closed: {
    readonly reason: QuestionCloseReason
    readonly at: string
    readonly by: string
    readonly byName: string
    /** The asking run continued past it without an answer -- the timeout pass's close, never a
     *  card's expiry ({@link runContinuedPast}; final wave, finding 7). */
    readonly runContinued: boolean
  } | null
  /** Why the timeout pass could not resume the parked asker (spec H3: "the card says why"). */
  readonly timeoutRefusal: string | null
  /** Task 7 carry: a late answer no run will read keeps its card open, and the card says so --
   *  `LATE_ANSWER_NOTE.unread`, derived at read time (never stored, so it cannot go stale). Null
   *  otherwise. */
  readonly lateAnswerNote: string | null
  /** Where an answer given now goes, for a question its run continued past (`timed_out`); null for
   *  any other. Spec H3: "the card says where it will go". */
  readonly lateAnswerFate: LateAnswerFate | null
}

/** A `closedBy` in the words a person reads ({@link closerWords}); `names` holds the accounts
 *  already read ({@link closerNames}). */
export function closerName(by: string | null, names: ReadonlyMap<string, string>): string {
  return closerWords(by, by === null ? undefined : names.get(by))
}

/** The account names behind a set of `closedBy`/`resolvedByUserId` values, in one read. */
export async function closerNames(ids: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
  const accounts = [...new Set(ids.filter((id): id is string => id !== null && id !== CLOSED_BY_SYSTEM && id !== CLOSED_BY_OPERATOR))]
  if (accounts.length === 0) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: accounts } }, select: { id: true, username: true } })
  return new Map(users.map((user) => [user.id, user.username] as const))
}

/**
 * Every card's question in one read (plan A D13); a message that is gone is simply absent. A fixed
 * number of queries whatever the page holds: the questions, the parked runs, each run's latest
 * question, the routed goal versions and the closers' names.
 */
export async function loadQuestionCards(workspaceId: string, messageIds: readonly string[]): Promise<ReadonlyMap<string, QuestionCard>> {
  if (messageIds.length === 0) return new Map()
  const rows = await prisma.slaveMessage.findMany({
    where: { workspaceId, id: { in: [...messageIds] }, kind: 'question' },
    select: {
      id: true,
      body: true,
      senderRunId: true,
      seq: true,
      closedAt: true,
      closedReason: true,
      closedBy: true,
      closedNote: true,
      timeoutRefusal: true,
      replies: { where: { kind: 'answer' }, take: 1, select: { id: true } },
      task: { select: { goalVersion: true, status: true, workPackageId: true, workPackage: { select: { key: true, goalVersion: true } } } },
    },
  })
  const runIds = [...new Set(rows.flatMap((row) => (row.senderRunId === null ? [] : [row.senderRunId])))]
  const parked =
    runIds.length === 0
      ? new Set<string>()
      : new Set(
          (await prisma.slaveRun.findMany({ where: { id: { in: runIds }, status: 'paused', pauseReason: 'waiting_for_answer' }, select: { id: true } })).map((run) => run.id),
        )
  // A parked run waits on its LATEST question only; an earlier one of its questions is not what holds it.
  const latest =
    parked.size === 0
      ? new Map<string | null, bigint | null>()
      : new Map(
          (
            await prisma.slaveMessage.groupBy({ by: ['senderRunId'], where: { senderRunId: { in: [...parked] }, kind: 'question' }, _max: { seq: true } })
          ).map((group) => [group.senderRunId, group._max.seq] as const),
        )
  const names = await closerNames(rows.map((row) => row.closedBy))
  // The asking packages' goal versions' delivery statuses, for `lateAnswerFateOf` (final wave round 2).
  const versions = [...new Set(rows.flatMap((row) => (row.task?.workPackage === null || row.task?.workPackage === undefined ? [] : [row.task.workPackage.goalVersion])))]
  const deliveryStatusOf =
    versions.length === 0
      ? new Map<number, string>()
      : new Map((await prisma.goalDelivery.findMany({ where: { workspaceId, goalVersion: { in: versions } }, select: { goalVersion: true, status: true } })).map((d) => [d.goalVersion, d.status] as const))
  return new Map(
    rows.map((row) => {
      const packageVersion = row.task?.workPackage?.goalVersion
      const fate = row.closedReason === 'timed_out' ? lateAnswerFateOf(row.task, packageVersion === undefined ? null : (deliveryStatusOf.get(packageVersion) ?? null)) : null
      const card: QuestionCard = {
        messageId: row.id,
        body: row.body,
        goalVersion: row.task?.workPackage?.goalVersion ?? row.task?.goalVersion ?? null,
        askerPackageKey: row.task?.workPackage?.key ?? null,
        askerRunId: row.senderRunId,
        askerWaiting: row.senderRunId !== null && parked.has(row.senderRunId) && latest.get(row.senderRunId) === row.seq,
        closed:
          row.closedAt === null || row.closedReason === null
            ? null
            : {
                reason: row.closedReason,
                at: row.closedAt.toISOString(),
                by: row.closedBy ?? CLOSED_BY_SYSTEM,
                byName: closerName(row.closedBy, names),
                runContinued: runContinuedPast({ reason: row.closedReason, note: row.closedNote }),
              },
        timeoutRefusal: row.timeoutRefusal,
        lateAnswerNote: fate === 'unread' && row.replies.length > 0 ? LATE_ANSWER_NOTE.unread : null,
        lateAnswerFate: fate,
      }
      return [row.id, card] as const
    }),
  )
}

export { CLOSED_BY_SYSTEM }
