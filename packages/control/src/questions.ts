import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CLOSED_BY_OPERATOR,
  CLOSED_BY_SYSTEM,
  CLOSED_NOTE_MAX_CHARS,
  LATE_ANSWER_NOTE,
  QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS,
  QUESTION_SITUATION_KINDS,
  TERMINAL,
  storableText,
  trimToFit,
  type LateAnswerFate,
  type QuestionCloseReason,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'

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

/**
 * Closes one question on its own (a card verb, an expiry, a timeout): the question row is locked
 * first (`claimTheAnswer`'s mutex), the note is built from the question as stored, and the event
 * follows the commit. True when this call closed it.
 */
export async function closeQuestion(
  input: Omit<CloseQuestionInput, 'note'> & { readonly note: (question: { readonly body: string; readonly createdAt: Date }) => string | null },
  actor: 'human' | 'system',
  userId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${input.messageId} FOR UPDATE`
    const question = await tx.slaveMessage.findUnique({
      where: { id: input.messageId },
      select: { workspaceId: true, taskId: true, slaveId: true, body: true, createdAt: true },
    })
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
 * the asking task -- on `tx` when the caller holds the question's lock. A package task: a hand-off.
 * A task outside any package that has not finished: its next run's inbox. A finished one, or no
 * task at all (a task-less planning run has no next run on anything): nobody reads it.
 */
export async function lateAnswerFate(client: Prisma.TransactionClient, questionId: string): Promise<LateAnswerFate> {
  const question = await client.slaveMessage.findUnique({ where: { id: questionId }, select: { task: { select: { workPackageId: true, status: true } } } })
  const task = question?.task ?? null
  if (task === null) return 'unread'
  if (task.workPackageId !== null) return 'hand_off'
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

export { CLOSED_BY_SYSTEM }
