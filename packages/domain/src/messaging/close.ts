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
