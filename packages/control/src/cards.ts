import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CLOSED_BY_SYSTEM,
  actionSchema,
  cardDecisionSchema,
  decidedResumeMessage,
  draftSchema,
  isQuestionSituation,
  personDecisionSummary,
  personText,
  storableJsonReviver,
  type Action,
  type CardDecision,
  type CardDecisionKind,
  type PersonDecision,
  type QuestionCloseReason,
  type Result,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { answerQuestion } from './messaging.js'
import type { Principal } from './principal.js'
import {
  announceQuestionClosed,
  closeQuestionIn,
  closedByOf,
  lateAnswerFate,
  loadQuestionCards,
  lockCardQuestion,
  retireQuestionCards,
  type CloseQuestionInput,
  type QuestionCard,
} from './questions.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { approveDecision, withOffers } from './supervisor.js'

/**
 * Human-cards spec H2 (plan B): a person decides a question card. Every decision claims the card
 * and closes its question in ONE transaction, so a decision that lost the race writes nothing and
 * the person is told who took the card and when (spec §4). A refused decision does not close the
 * question: inside the transaction a refusal is THROWN ({@link CardRefused}) -- a returned value
 * would commit the claim already written.
 */

/** What a decided card reports back. */
export interface DecideOutcome {
  readonly decision: CardDecisionKind
  readonly summary: string
}

/** Thrown inside a card's transaction: rolls the claim and the close back (constraint: a refusal there must throw). */
export class CardRefused extends Error {
  constructor(readonly refusal: ControlRefusal) {
    super(refusal.kind)
    this.name = 'CardRefused'
  }
}

/** The pending card a decision is about, as `decideCard` read it. */
export interface PendingCard {
  readonly id: string
  readonly workspaceId: string
  readonly subjectId: string
  readonly actionKind: string
  /** The card's proposed action as stored (the `supervisor.failed` event names it). */
  readonly action: Action
  readonly question: QuestionCard
}

export interface ClaimInput {
  readonly card: PendingCard
  readonly status: 'approved' | 'rejected'
  readonly principal: Principal | undefined
  readonly personDecision: PersonDecision
  /** The close to write; null writes none. A `timed_out` question is not closed again (plan A D1). */
  readonly close: { readonly reason: QuestionCloseReason; readonly note: string | null } | null
  readonly now: Date
}

/**
 * A decision as it can be stored: every text without a NUL byte or a lone surrogate (Postgres refuses
 * both in `jsonb`, 22P05), then read again by the one schema -- so a text that was nothing but such
 * characters is refused like an empty one rather than stored as a row `personDecisionSchema` cannot
 * read back. Null when it no longer reads.
 */
function storableDecision(decision: CardDecision): CardDecision | null {
  const cleaned: unknown = JSON.parse(JSON.stringify(decision), storableJsonReviver)
  const reread = cardDecisionSchema.safeParse(cleaned)
  return reread.success ? reread.data : null
}

const isAnswer = (decision: CardDecision): boolean => decision.kind === 'send_answer' || decision.kind === 'write_answer'

/**
 * Plan B D2: inside `tx`, locks the question, claims the card and closes the question. THROWS
 * {@link CardRefused} when the card was resolved or the question closed first, so a decision that
 * lost writes nothing. Returns the close it wrote, or null when it wrote none (no close asked for,
 * or the question had already timed out).
 *
 * Ruling F29: the lock is Plan A's one order -- the Workspace row, then the question row
 * ({@link lockCardQuestion}) -- so no card is recorded and no answer lands between this read and the
 * close; the close state is read from the lock's own result. The claim comes BEFORE the closed check:
 * a second person deciding the same card is told the card was taken (who, when), not that its
 * question closed.
 */
export async function claimAndClose(tx: Prisma.TransactionClient, input: ClaimInput): Promise<CloseQuestionInput | null> {
  const { card } = input
  const question = await lockCardQuestion(tx, card.workspaceId, card.subjectId)
  // Before the first write: a throw here and a return would both commit nothing.
  if (question === null) throw new CardRefused({ kind: 'message_not_found', messageId: card.subjectId })
  const claimed = await tx.supervisorDecision.updateMany({
    where: { id: card.id, status: 'pending' },
    data: {
      status: input.status,
      resolvedAt: input.now,
      resolvedByUserId: input.principal?.userId ?? null,
      personDecision: input.personDecision as unknown as Prisma.InputJsonValue,
    },
  })
  if (claimed.count === 0) {
    const current = await tx.supervisorDecision.findUnique({ where: { id: card.id }, select: { status: true, resolvedAt: true, resolvedByUserId: true } })
    if (current === null) throw new CardRefused({ kind: 'decision_not_found', decisionId: card.id })
    throw new CardRefused({ kind: 'decision_not_pending', decisionId: card.id, status: current.status, resolvedAt: current.resolvedAt?.toISOString() ?? null, resolvedByUserId: current.resolvedByUserId })
  }
  // From here on the claim is written: every refusal THROWS, so the transaction rolls it back.
  if (question.closedAt !== null && question.closedReason !== null && question.closedReason !== 'timed_out') {
    throw new CardRefused({ kind: 'question_closed', messageId: card.subjectId, reason: question.closedReason, by: question.closedBy ?? CLOSED_BY_SYSTEM, at: question.closedAt.toISOString() })
  }
  if (question.closedReason === 'timed_out') {
    // Ruling F37, under the lock: a late answer no run would read is not offered -- the delivery may
    // have moved since `decideCard` read the card.
    if (isAnswer(input.personDecision.decision) && (await lateAnswerFate(tx, card.subjectId)) === 'unread') {
      throw new CardRefused({ kind: 'card_decision_not_offered', decisionId: card.id, decision: input.personDecision.decision.kind })
    }
    return null
  }
  if (input.close === null) return null
  const close: CloseQuestionInput = { messageId: card.subjectId, reason: input.close.reason, by: closedByOf(input.principal), note: input.close.note, decisionId: card.id }
  if (!(await closeQuestionIn(tx, close, input.now))) throw new CardRefused({ kind: 'question_answered', messageId: card.subjectId })
  return close
}

/**
 * After the commit: the card's event, the question's, and the other cards about it retired. Ruling
 * F54: each step is said and swallowed -- the decision is committed, so a throw here would report it
 * as failed (and a retry would meet `decision_not_pending`); the tick's `retireClosedQuestionCards`
 * is the backstop for a card left open.
 */
export async function afterClaim(card: PendingCard, input: ClaimInput, close: CloseQuestionInput | null): Promise<void> {
  const userId = input.principal?.userId ?? null
  try {
    await appendEvent({
      type: 'supervisor.resolved',
      workspaceId: card.workspaceId,
      actor: 'human',
      payload: { decisionId: card.id, outcome: input.status, reason: `A person decided: ${input.personDecision.summary}` },
      userId,
    })
  } catch (error) {
    console.error(`[cards] decision ${card.id}: its resolved event was not written:`, error)
  }
  if (close !== null) {
    try {
      const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: card.subjectId }, select: { workspaceId: true, taskId: true, slaveId: true } })
      await announceQuestionClosed(question, { ...close, note: input.personDecision.summary }, 'human', userId)
    } catch (error) {
      console.error(`[cards] decision ${card.id}: its question's close event was not written:`, error)
    }
  }
  try {
    await retireQuestionCards(card.workspaceId, card.subjectId, 'A person decided the question on another card.', input.now, card.id)
  } catch (error) {
    console.error(`[cards] decision ${card.id}: the other cards about its question were not retired:`, error)
  }
}

/** Runs a card's transaction, turning a thrown {@link CardRefused} back into a refusal. */
export async function inCardTransaction<T>(work: () => Promise<T>): Promise<Result<T, ControlRefusal>> {
  try {
    return ok(await work())
  } catch (error) {
    if (error instanceof CardRefused) return err(error.refusal)
    throw error
  }
}

/**
 * The status a person's decision leaves the card in (plan B D3): `approved` only when the person
 * carried out what the card asked -- an answer on an answer card or on an escalation, any decision
 * on an escalation. On a card proposing the machine's own move (hire, seat, assign a capability,
 * re-address), a person's answer or decision is `rejected`: that proposed action was not taken
 * (Task 3 ruling, review I1).
 */
function statusFor(actionKind: string, decision: CardDecision): 'approved' | 'rejected' {
  if (decision.kind === 'dismiss') return 'rejected'
  if (decision.kind === 'send_answer' || decision.kind === 'write_answer') return actionKind === 'answer_question' || actionKind === 'escalate_to_human' ? 'approved' : 'rejected'
  return actionKind === 'escalate_to_human' ? 'approved' : 'rejected'
}

/**
 * Human-cards spec H2: a person decides a question card. Everything a decision can be refused for
 * that can be known without the lock is checked first (plan B D2) -- each of those refusals is
 * returned before anything is written; the rest is refused inside the card's transaction by a throw,
 * so a refused decision closes nothing. Machine cards keep approve and reject.
 */
export async function decideCard(decisionId: string, raw: unknown, principal?: Principal): Promise<Result<DecideOutcome, ControlRefusal>> {
  const parsed = cardDecisionSchema.safeParse(raw)
  if (!parsed.success) return err({ kind: 'invalid_card_decision', reason: parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ') })
  const decision = storableDecision(parsed.data)
  if (decision === null) return err({ kind: 'invalid_card_decision', reason: 'a text is empty once the characters that cannot be stored are removed' })
  const row = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { id: true, workspaceId: true, situationKind: true, subjectId: true, status: true, action: true, draft: true, resolvedAt: true, resolvedByUserId: true },
  })
  // Every refusal from here to the transaction is returned before the first write.
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  if (!isQuestionSituation(row.situationKind)) return err({ kind: 'card_not_a_question', decisionId })
  if (row.status !== 'pending') {
    return err({ kind: 'decision_not_pending', decisionId, status: row.status, resolvedAt: row.resolvedAt?.toISOString() ?? null, resolvedByUserId: row.resolvedByUserId })
  }
  const action = actionSchema.safeParse(row.action)
  if (!action.success) throw new TypeError(`decideCard: SupervisorDecision ${decisionId}.action does not parse`)
  const draft = row.draft === null ? null : draftSchema.safeParse(row.draft)
  const loaded = (await loadQuestionCards(row.workspaceId, [row.subjectId])).get(row.subjectId)
  if (loaded === undefined) return err({ kind: 'message_not_found', messageId: row.subjectId })
  const question = withOffers(loaded, action.data, draft?.success === true ? draft.data : null) ?? loaded
  if (question.closed !== null && question.closed.reason !== 'timed_out') {
    return err({ kind: 'question_closed', messageId: row.subjectId, reason: question.closed.reason, by: question.closed.by, at: question.closed.at })
  }
  if (!question.offers.includes(decision.kind)) return err({ kind: 'card_decision_not_offered', decisionId, decision: decision.kind })

  const card: PendingCard = { id: row.id, workspaceId: row.workspaceId, subjectId: row.subjectId, actionKind: action.data.kind, action: action.data, question }
  const now = new Date()
  const target = { packageKey: decision.kind === 'give_file' ? decision.toPackage : decision.kind === 'give_work' && 'package' in decision.target ? decision.target.package : null }
  const record = (extra: Partial<PersonDecision> = {}): PersonDecision => ({
    decision,
    goalVersion: question.goalVersion,
    by: closedByOf(principal),
    at: now.toISOString(),
    summary: personDecisionSummary(decision, target),
    ...extra,
  })
  const status = statusFor(card.actionKind, decision)

  switch (decision.kind) {
    case 'send_answer':
    case 'write_answer':
      return decideAnswer(card, decision, record(), status, principal, now)
    case 'dismiss': {
      const input: ClaimInput = {
        card,
        status,
        principal,
        personDecision: record(),
        close: { reason: 'dismissed', note: decidedResumeMessage(decision, { packageKey: null, askerPackageKey: question.askerPackageKey }) },
        now,
      }
      const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
      if (!claimed.ok) return claimed
      await afterClaim(card, input, claimed.value)
      return ok({ decision: decision.kind, summary: input.personDecision.summary })
    }
    case 'give_work':
    case 'record_decision':
    case 'change_requirement':
    case 'give_file':
      // Tasks 4 and 5.
      return decideOther(card, decision, record, status, principal, now)
  }
}

/**
 * H2.1/H2.2: an answer. On an answer card, the approval path (an edit for a person's own words,
 * which applies neither the draft's decision nor its hand-off). On any other question card, the card
 * is claimed with no close -- `answerQuestion` closes the question `answered` in its own transaction
 * -- and a refusal there marks the card failed with the reason and a `supervisor.failed` event. The
 * card is `approved` on an escalation and `rejected` on a re-address card, whose proposed move was
 * not taken ({@link statusFor}). A crash between the two leaves the card resolved with the person's
 * text in `personDecision`, and `healApprovedClose` leaves such a question open rather than closing
 * it `decided` (ruling F51).
 */
async function decideAnswer(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'send_answer' | 'write_answer' }>,
  personDecision: PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  // The person's words made inert and storable (no NUL, no protocol marker, no routing literal):
  // they reach the asker's resume turn as they are stored.
  const body = decision.kind === 'write_answer' ? personText(decision.body) : null
  // Before any write: a body of NULs alone is empty once storable.
  if (body === '') return err({ kind: 'invalid_card_decision', reason: 'the answer is empty' })
  if (card.actionKind === 'answer_question') {
    // The person's decision is written by the approval's own conditional claim (review M4), so a
    // card is never approved without it; the resolved event carries its summary.
    const approved = await approveDecision(card.id, principal, body === null ? undefined : { body }, personDecision)
    if (!approved.ok) return approved
    return ok({ decision: decision.kind, summary: personDecision.summary })
  }
  if (body === null) return err({ kind: 'card_decision_not_offered', decisionId: card.id, decision: decision.kind })
  const input: ClaimInput = { card, status, principal, personDecision, close: null, now }
  const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
  if (!claimed.ok) return claimed
  const answered = await answerQuestion(card.subjectId, { body, answeredBy: 'a person, on a card', ...(principal === undefined ? {} : { principal }) }, 'human')
  if (!answered.ok) {
    // The claim committed, the answer did not: the card says why, and the question stays as it was
    // (spec §4: a refused decision does not close the question).
    // Recorded as `applyDecision` records a refused action: the row `failed` with the reason, and a
    // `supervisor.failed` event (review M6). Said and swallowed: the refusal is what is returned.
    try {
      const reason = refusalText(answered.error)
      const failed = await prisma.supervisorDecision.updateMany({ where: { id: card.id, status }, data: { status: 'failed', failureReason: reason } })
      if (failed.count === 1) {
        await appendEvent({ type: 'supervisor.failed', workspaceId: card.workspaceId, actor: 'system', payload: { decisionId: card.id, action: card.action, reason }, userId: principal?.userId ?? null })
      }
    } catch (error) {
      console.error(`[cards] decision ${card.id}: its refused answer was not recorded:`, error)
    }
    return answered
  }
  await afterClaim(card, input, null)
  return ok({ decision: decision.kind, summary: personDecision.summary })
}

/** Tasks 4 and 5 fill this in; until then the decision is refused and nothing is written. */
function decideOther(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_work' | 'record_decision' | 'change_requirement' | 'give_file' }>,
  _record: (extra?: Partial<PersonDecision>) => PersonDecision,
  _status: 'approved' | 'rejected',
  _principal: Principal | undefined,
  _now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  return Promise.resolve(err({ kind: 'card_decision_not_offered', decisionId: card.id, decision: decision.kind }))
}
