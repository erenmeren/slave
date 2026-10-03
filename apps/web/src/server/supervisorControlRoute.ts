import { prisma } from '@slave-of-ai/db/client'
import { closerName, closerNames, refusalText, type ControlRefusal } from '@slave-of-ai/control'
import { isQuestionSituation, resolverWords, type Result } from '@slave-of-ai/domain'
import { formatUtcMinute } from '../lib/format'
import { refusalStatus } from './refusalStatus'

/**
 * Route shell for a verb addressed at one `SupervisorDecision` (M38 §6): 404 unless the decision
 * exists IN THIS WORKSPACE, then `refusalStatus` on the verb's own refusal.
 *
 * The same shape and the same pre-check reason as `slaveControlResponse`: a decision belonging to
 * another project must read back exactly like one that never existed, so that an id guessed (or
 * pasted) from somewhere else tells the caller nothing about whether it is real. `approveDecision`
 * and `rejectDecision` would refuse `decision_not_found` for an unknown id anyway -- and that maps
 * to 404 through `refusalStatus` -- but they know nothing about workspaces, so without this check
 * a cross-project approve would succeed.
 *
 * `Result<unknown, ...>`, not `Result<void, ...>`, for the reason the sibling shells give: the
 * envelope is `{ ok: true }` whatever the verb returns -- unless `present` says what of the value a
 * page needs, which is spread beside `ok` (the decide route's `outcome`, plan B Task 6).
 *
 * `statusOf` overrides `refusalStatus` for a route whose verb can refuse the request's own body
 * after the route's schema passed it -- the decide route's `invalid_card_decision` is a malformed
 * body (400), never a card that declined (409) (plan B Task 6 carry).
 */
export async function decisionControlResponse<T>(
  workspaceId: string,
  decisionId: string,
  operate: () => Promise<Result<T, ControlRefusal>>,
  present?: (value: T) => Readonly<Record<string, unknown>>,
  statusOf: (kind: ControlRefusal['kind']) => number = refusalStatus,
): Promise<Response> {
  const decision = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { workspaceId: true },
  })
  if (decision === null || decision.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such decision in this workspace' }, { status: 404 })
  }
  const result = await operate()
  if (result.ok) return Response.json(present === undefined ? { ok: true } : { ok: true, ...present(result.value) })
  const notice = await settledNotice(result.error, decisionId)
  return Response.json({ error: refusalText(result.error), ...(notice === null ? {} : { notice }) }, { status: statusOf(result.error.kind) })
}

/**
 * Human cards spec §4 (Task 4 carry): a card somebody else settled first -- its question closed, or
 * the card itself resolved -- is not an error the person made. The response carries a `notice`, in
 * words ("Already closed by alice at 2026-10-02 10:00 UTC."), which the page shows as information
 * and follows with a refresh of the queue. Null for every other refusal. Exported: the answer box's
 * route (`messageControlResponse`) says the same of a question closed first.
 *
 * Who is named (fix round 1): the question's closer when a question card's question is closed --
 * an answer in the answer box retires the card with no user on it, and the truth is on the question
 * row; otherwise the card's own resolver ({@link resolverWords}: a null user on a person's verdict
 * is the CLI's operator, on an expiry or a birth-applied card Slave). An account is named by its
 * username, never by its id.
 */
export async function settledNotice(refusal: ControlRefusal, decisionId: string | null = null): Promise<string | null> {
  if (refusal.kind === 'question_closed') return closedBy(refusal.by, refusal.at)
  if (refusal.kind !== 'decision_not_pending') return null
  const card = decisionId === null
    ? null
    : await prisma.supervisorDecision.findUnique({ where: { id: decisionId }, select: { situationKind: true, subjectId: true } })
  if (card !== null && isQuestionSituation(card.situationKind)) {
    const question = await prisma.slaveMessage.findUnique({ where: { id: card.subjectId }, select: { closedAt: true, closedBy: true } })
    if (question?.closedAt != null) return closedBy(question.closedBy, question.closedAt.toISOString())
  }
  const userId = refusal.resolvedByUserId ?? null
  const names = await closerNames([userId])
  const name = resolverWords(refusal.status, userId, userId === null ? undefined : names.get(userId))
  return sentence(name, refusal.resolvedAt ?? null)
}

/** A question's closer and close time as the notice. */
async function closedBy(by: string | null, at: string): Promise<string> {
  return sentence(closerName(by, await closerNames([by])), at)
}

function sentence(name: string, at: string | null): string {
  return `Already closed by ${name}${at === null ? '' : ` at ${formatUtcMinute(at)}`}.`
}

