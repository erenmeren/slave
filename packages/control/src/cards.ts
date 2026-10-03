import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CLOSED_BY_SYSTEM,
  HANDOFF_CHANGE_MAX_CHARS,
  actionSchema,
  cardDecisionSchema,
  decidedResumeMessage,
  draftSchema,
  handOffRoute,
  isQuestionSituation,
  personDecisionSummary,
  personText,
  planFileGrant,
  registrationsSchema,
  resolveHandOff,
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
import { GoalDecisionRefused, lockGoalDecisions, writeGoalDecisionIn } from './conductorAnswer.js'
import { announceGoalVersion, requestChangeIn } from './goal.js'
import { withDeliveryLock } from './goalDelivery.js'
import { personHandOffSourceKey, routeHandOffs } from './handOffs.js'
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
import { isUniqueConstraintViolation } from './prisma-errors.js'
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

/** Ruling F38: what a held hand-off's summary adds -- the version is not integrating, so no run reads it yet. */
const HELD_NOTE = ' (it waits until the version is integrating again)'

/**
 * H2.3, H2.5, H2.6 (and Task 5's H2.4): the decisions that act on the version. Each claims the card
 * and closes its question in one transaction ({@link claimAndClose}); a refusal known before the
 * claim is returned before anything is written, and one met after it THROWS so the claim rolls back.
 */
async function decideOther(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_work' | 'record_decision' | 'change_requirement' | 'give_file' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  switch (decision.kind) {
    case 'give_work':
      return giveWork(card, decision, record, status, principal, now)
    case 'record_decision':
      return recordSharedDecision(card, decision, record, status, principal, now)
    case 'change_requirement':
      return changeRequirement(card, decision, record, status, principal, now)
    case 'give_file':
      return giveFile(card, decision, record, status, principal, now)
  }
}

const refusedCard = (card: PendingCard, reason: string): Result<never, ControlRefusal> => err({ kind: 'card_decision_refused', decisionId: card.id, reason })

/**
 * H2.3 (plan B D4): a package is given work. The target is resolved by the ownership rule
 * (`resolveHandOff`, from nobody's package, so the asker's own package is a real target) and, ruling
 * F38, refused BEFORE the claim unless `handOffRoute` -- the rule `routeHandOffs` stores by -- says
 * the request would be delivered or held: a failed or cancelled target task would turn a person's
 * request into a conductor question, and an ended version would store it expired. Every refusal here
 * is returned before the first write. The routing runs after the commit, with no lock held; a
 * failure there is said and swallowed, and the goal pass routes it (`routeStoredPersonHandOffs`).
 * Residual race: a target task or the delivery moving between this read and the routing is stored
 * as `routeHandOffs` rules at that moment.
 */
async function giveWork(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_work' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const version = card.question.goalVersion
  const askerRunId = card.question.askerRunId
  if (version === null || askerRunId === null) return refusedCard(card, 'the question belongs to no goal version with packages, or no run asked it')
  const [delivery, packages] = await Promise.all([
    prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId: card.workspaceId, goalVersion: version } }, select: { status: true } }),
    prisma.workPackage.findMany({
      where: { workspaceId: card.workspaceId, goalVersion: version },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        ownedPaths: true,
        releasedPaths: true,
        isIntegration: true,
        // Plan A D2: a package's one task is its oldest, as `routeHandOffs` reads it.
        tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { status: true } },
      },
    }),
  ])
  const request = personText(decision.request, HANDOFF_CHANGE_MAX_CHARS)
  if (request === '') return err({ kind: 'invalid_card_decision', reason: 'the request is empty' })
  const item = 'package' in decision.target ? { package: decision.target.package, change: request } : { path: decision.target.path, change: request }
  const resolved = resolveHandOff(item, null, packages)
  if (resolved.kind !== 'package') return refusedCard(card, resolved.kind === 'none' ? resolved.reason : 'no package can take it')
  const taskStatus = packages.find((pkg) => pkg.key === resolved.key)?.tasks[0]?.status
  const route = handOffRoute(delivery?.status ?? null, taskStatus)
  if (route === 'to_conductor') return refusedCard(card, `the ${resolved.key} package cannot take work: its task is ${taskStatus ?? 'gone'}`)
  if (route === 'expired') return refusedCard(card, `goal v${String(version)} was ${delivery?.status ?? 'ended'}: none of its packages takes work any more`)
  const target = { packageKey: resolved.key, askerPackageKey: card.question.askerPackageKey }
  const summary = `${personDecisionSummary(decision, target)}${route === 'held' ? HELD_NOTE : ''}`
  const input: ClaimInput = {
    card,
    status,
    principal,
    personDecision: record({ summary }),
    // Ruling F57: work given to the asker's own package is worded as its work to do.
    close: { reason: 'decided', note: decidedResumeMessage(decision, target) },
    now,
  }
  const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
  if (!claimed.ok) return claimed
  await afterClaim(card, input, claimed.value)
  try {
    await routeHandOffs({
      workspaceId: card.workspaceId,
      goalVersion: version,
      source: 'person',
      sourceKey: personHandOffSourceKey(card.id),
      fromRunId: askerRunId,
      fromPackageKey: null,
      items: [item],
    })
  } catch (error) {
    // Said and swallowed: the decision is committed; the goal pass routes it (`routeStoredPersonHandOffs`).
    console.error(`[cards] card ${card.id}: its hand-off waits for the next goal pass:`, error)
  }
  return ok({ decision: decision.kind, summary })
}

/**
 * H2.5 (plan B D6): a person's shared decision for the question's goal version, written in the card's
 * transaction ({@link writeGoalDecisionIn}); a taken title (however cased or spaced), the version's
 * cap or a text empty once defused THROWS, so the claim and the close roll back.
 *
 * Lock order: the version's goal-decisions advisory lock, then the Workspace row, then the question
 * row. The conductor's writer takes the advisory lock and then (the insert's foreign key) a share
 * lock on the Workspace row, and nothing takes the advisory lock while holding the Workspace row,
 * so the advisory lock must come first here too. The claim precedes the write, so a person who lost
 * the card is told who took it, not that the title was taken by the winner.
 */
async function recordSharedDecision(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'record_decision' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const version = card.question.goalVersion
  // Before any write.
  if (version === null) return refusedCard(card, 'the question belongs to no goal version')
  const input: ClaimInput = {
    card,
    status,
    principal,
    personDecision: record(),
    close: { reason: 'decided', note: decidedResumeMessage(decision, { packageKey: null, askerPackageKey: card.question.askerPackageKey }) },
    now,
  }
  let claimed: Result<CloseQuestionInput | null, ControlRefusal>
  try {
    claimed = await inCardTransaction(() =>
      prisma.$transaction(async (tx) => {
        await lockGoalDecisions(tx, card.workspaceId, version)
        const close = await claimAndClose(tx, input)
        try {
          await writeGoalDecisionIn(tx, { workspaceId: card.workspaceId, goalVersion: version, title: decision.title, decision: decision.text, source: 'person', questionId: card.subjectId, decisionId: card.id })
        } catch (error) {
          if (error instanceof GoalDecisionRefused) throw new CardRefused({ kind: 'card_decision_refused', decisionId: card.id, reason: error.message })
          throw error
        }
        return close
      }),
    )
  } catch (error) {
    // Only a writer outside the advisory lock (the plan's own decisions) can reach the unique key;
    // the transaction rolled back, so the card is still pending.
    if (isUniqueConstraintViolation(error)) return refusedCard(card, `goal v${String(version)} already has a shared decision with that title`)
    throw error
  }
  if (!claimed.ok) return claimed
  await afterClaim(card, input, claimed.value)
  return ok({ decision: decision.kind, summary: input.personDecision.summary })
}

/**
 * H2.6: a requirement changed through a new goal version (`requestChange`'s write), superseding the
 * question. Ruling F53: the version is written on the card's transaction ({@link requestChangeIn})
 * after the claim and the close, and a refusal (a duplicate request, a missing workspace) THROWS, so
 * a change the goal refuses closes nothing and leaves the card pending. Lock order: the Workspace
 * row, then the question row (`claimAndClose`), then the Workspace row again -- a no-op in the same
 * transaction. The version's `workspace.goal_set` event and memory follow the commit, said and
 * swallowed.
 */
async function changeRequirement(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'change_requirement' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const request = personText(decision.request)
  // Before any write.
  if (request === '') return err({ kind: 'invalid_card_decision', reason: 'the request is empty' })
  const input: ClaimInput = {
    card,
    status,
    principal,
    personDecision: record(),
    close: { reason: 'superseded', note: decidedResumeMessage(decision, { packageKey: null, askerPackageKey: card.question.askerPackageKey }) },
    now,
  }
  const claimed = await inCardTransaction(() =>
    prisma.$transaction(async (tx) => {
      const close = await claimAndClose(tx, input)
      const changed = await requestChangeIn(tx, card.workspaceId, request, principal, now)
      if (!changed.ok) throw new CardRefused(changed.error)
      return { close, changed: changed.value }
    }),
  )
  if (!claimed.ok) return claimed
  await afterClaim(card, input, claimed.value.close)
  try {
    await announceGoalVersion(card.workspaceId, claimed.value.changed, principal, request, null)
  } catch (error) {
    console.error(`[cards] card ${card.id}: goal v${String(claimed.value.changed.version)}'s event was not written:`, error)
  }
  return ok({ decision: decision.kind, summary: input.personDecision.summary })
}

/**
 * Human cards H2.4 (plan B D5): the one ownership change in the system. Under the delivery's lock
 * ({@link withDeliveryLock}, the lock every verification, smoke and merge claim takes), and only while
 * the version is integrating with no smoke or verification claim and neither the giving nor the
 * receiving package's task holds a run: a run reads its ownership when it starts (the gate's
 * permissions file) and the diff audit reads it again when it ends, so a grant under a live run
 * would judge that run by a rule it did not start with. `planFileGrant` judges the move against the
 * version's packages (disjointness, the manifest family, a shared registration directory).
 *
 * One transaction: the claim and the close ({@link claimAndClose}), then the `WorkPackage` writes,
 * each guarded on the arrays it read -- a write that lost THROWS, so a refused or lost grant changes
 * no package and closes nothing, and the card stays pending (spec §4). Every refusal known only
 * under the lock is thrown after the claim, so a person who lost the card is told who took it.
 *
 * Lock order (the one order every path keeps): the delivery's advisory lock, then the Workspace row,
 * then the question row (`lockCardQuestion`), then the two packages' task rows (`FOR SHARE`, so a
 * dispatch claiming either task waits for the grant and its run then reads the new rule), then the
 * `WorkPackage` rows the writes touch. Nothing takes the delivery lock while holding any of these:
 * `withDeliveryLock` always opens its own transaction, and no caller runs inside another.
 */
async function giveFile(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_file' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const version = card.question.goalVersion
  // Before any write.
  if (version === null) return refusedCard(card, 'the question belongs to no goal version')
  const delivery = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId: card.workspaceId, goalVersion: version } }, select: { id: true } })
  if (delivery === null) return refusedCard(card, `goal v${String(version)} has no delivery: a file is given only while its packages are integrating`)
  const refusedBy = (reason: string): CardRefused => new CardRefused({ kind: 'card_decision_refused', decisionId: card.id, reason })
  const done = await inCardTransaction(() =>
    withDeliveryLock(delivery.id, async (tx) => {
      const head = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: { status: true, activeSmokeId: true, activeRunId: true } })
      const packages = await tx.workPackage.findMany({
        where: { workspaceId: card.workspaceId, goalVersion: version },
        orderBy: { key: 'asc' },
        select: {
          id: true,
          key: true,
          ownedPaths: true,
          releasedPaths: true,
          isIntegration: true,
          registrations: true,
          // Plan A D2: a package's one task is its oldest.
          tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { id: true } },
        },
      })
      const plan = planFileGrant({
        path: decision.path,
        toKey: decision.toPackage,
        packages: packages.map((p) => ({ key: p.key, ownedPaths: p.ownedPaths, releasedPaths: p.releasedPaths, isIntegration: p.isIntegration, registrations: registrationsSchema.parse(p.registrations) })),
      })
      const input: ClaimInput = {
        card,
        status,
        principal,
        personDecision: record(plan.ok ? { grant: { path: plan.value.path, fromKey: plan.value.fromKey, toKey: plan.value.toKey } } : {}),
        close: { reason: 'decided', note: decidedResumeMessage(decision, { packageKey: decision.toPackage, askerPackageKey: card.question.askerPackageKey }) },
        now,
      }
      const close = await claimAndClose(tx, input)
      // From here on the claim is written: every refusal THROWS.
      if (head.status !== 'integrating' || head.activeSmokeId !== null || head.activeRunId !== null) {
        throw refusedBy(`goal v${String(version)} is being verified or smoked (or is over): a file is given only while it is integrating`)
      }
      if (!plan.ok) throw refusedBy(plan.error)
      const keys = [plan.value.fromKey, plan.value.toKey].filter((key): key is string => key !== null)
      const taskIds = keys.flatMap((key) => packages.find((p) => p.key === key)?.tasks.map((t) => t.id) ?? [])
      const tasks = taskIds.length === 0 ? [] : await tx.$queryRaw<{ id: string; activeRunId: string | null }[]>`SELECT id, "activeRunId" FROM "Task" WHERE id = ANY(${taskIds}::text[]) ORDER BY id FOR SHARE`
      for (const key of keys) {
        const taskId = packages.find((p) => p.key === key)?.tasks[0]?.id
        if (tasks.some((t) => t.id === taskId && t.activeRunId !== null)) {
          throw refusedBy(`the ${key} package has a live run: give the file once it has finished, or give the ${key} package the work instead`)
        }
      }
      for (const change of plan.value.changes) {
        const pkg = packages.find((p) => p.key === change.key)
        if (pkg === undefined) throw refusedBy(`the ${change.key} package is gone`)
        const moved = await tx.workPackage.updateMany({
          where: { id: pkg.id, ownedPaths: { equals: pkg.ownedPaths }, releasedPaths: { equals: pkg.releasedPaths } },
          data: { ownedPaths: [...change.ownedPaths], releasedPaths: [...change.releasedPaths] },
        })
        if (moved.count === 0) throw refusedBy('the packages changed while this was decided: decide again')
      }
      return { input, close }
    }),
  )
  if (!done.ok) return done
  await afterClaim(card, done.value.input, done.value.close)
  return ok({ decision: decision.kind, summary: done.value.input.personDecision.summary })
}
