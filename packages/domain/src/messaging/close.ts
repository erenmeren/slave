/**
 * Human-cards spec H1: how a question stops waiting. A leaf module (no imports), because the event
 * schema reads the reasons and must not import the Supervisor's modules to do it.
 */

/** Why a question was closed. The first close wins (plan A D1). */
export const QUESTION_CLOSE_REASONS = ['answered', 'decided', 'dismissed', 'timed_out', 'superseded'] as const
export type QuestionCloseReason = (typeof QUESTION_CLOSE_REASONS)[number]

/** `closedBy` for a close nobody made by hand: a timeout, an expiry, the Supervisor's own answer. */
export const CLOSED_BY_SYSTEM = 'system'
/** `closedBy` for a person with no account to name (the CLI acts with no session). */
export const CLOSED_BY_OPERATOR = 'operator'

/** Bounds `SlaveMessage.closedNote`, the turn a continued run opens with. */
export const CLOSED_NOTE_MAX_CHARS = 4000
/** Bounds the note `slave.question_closed` carries. */
export const QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS = 500
/** Bounds every free text a person writes on a card: an answer, a reason, a request. */
export const PERSON_CARD_TEXT_MAX_CHARS = 2000

/**
 * Who closed a question, in the words a person reads (human cards Task 8 fix round 1: one name
 * everywhere). Slave for a close nobody made by hand -- `system`, or a row with no `closedBy`; "an
 * operator" for a person with no account; the account's `name` when the caller read it, else "a
 * person". Never a raw user id.
 */
export function closerWords(by: string | null, name?: string): string {
  if (by === null || by === CLOSED_BY_SYSTEM) return 'Slave'
  if (by === CLOSED_BY_OPERATOR) return 'an operator'
  return name ?? 'a person'
}

/**
 * Who settled a card, by its status and `resolvedByUserId`, in the same words. A null user on a
 * verdict a person gives (approved, rejected, or one whose carry-out failed) is the CLI's operator,
 * which has no session to name; on an expired card or one applied at birth it is Slave.
 */
export function resolverWords(status: string, resolvedByUserId: string | null, name?: string): string {
  if (resolvedByUserId !== null) return name ?? 'a person'
  return status === 'approved' || status === 'rejected' || status === 'failed' ? 'an operator' : 'Slave'
}

/**
 * Final wave, finding 7: the `closedNote` a card's expiry leaves on the question it times out. An
 * expiry closes `timed_out` only when nobody is parked on the question, so no run continued past it
 * -- this marker is what tells that close apart from the timeout pass's, whose note is the turn
 * the resumed run was given.
 */
export const CARD_EXPIRED_NOTE = 'The card expired with no decision.'

/**
 * Whether a close means the asking run continued without an answer: a `timed_out` close the
 * timeout pass made (its run resumed), never a card's expiry ({@link CARD_EXPIRED_NOTE}). The one
 * rule the report's "continued without an answer" list, the card and the activity log read.
 */
export function runContinuedPast(closed: { readonly reason: QuestionCloseReason; readonly note: string | null }): boolean {
  return closed.reason === 'timed_out' && closed.note !== CARD_EXPIRED_NOTE
}
