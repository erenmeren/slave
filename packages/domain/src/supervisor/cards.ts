import { HANDOFF_CHANGE_MAX_CHARS } from '../conduct/constants.js'
import { storableText } from '../conduct/storable.js'
import { trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { CLOSED_NOTE_MAX_CHARS, PERSON_CARD_TEXT_MAX_CHARS, type QuestionCloseReason } from '../messaging/close.js'
import type { ActionKind } from './actions.js'
import type { SituationKind } from './situations.js'

/**
 * Human-cards spec H1: the situation kinds whose subject is a question (the message id). A card on
 * any of them is a card on that question, and a question has at most one open card (plan A D2).
 */
export const QUESTION_SITUATION_KINDS: readonly SituationKind[] = ['waiting_stale', 'unanswerable_question', 'conductor_question']

export function isQuestionSituation(kind: SituationKind): boolean {
  return QUESTION_SITUATION_KINDS.includes(kind)
}

/** The key a card is held under: the question for the question kinds, the situation key otherwise. */
export function cardKey(kind: SituationKind, subjectId: string): string {
  return isQuestionSituation(kind) ? `question:${subjectId}` : `${kind}:${subjectId}`
}

/**
 * Ruling F18 (amended): the approved actions that move a question to somebody who can answer it --
 * a hire, a seat, a capability or a role that makes a holder, or a re-address to a named worker.
 */
export const READDRESSING_ACTION_KINDS: readonly ActionKind[] = [
  'hire_from_catalog',
  'materialise_company_worker',
  'assign_capability',
  'set_runtime_roles',
  'reassign_question',
]

/** The situation kinds a re-address is about: a question nobody can answer, or one left waiting. */
const READDRESSABLE_SITUATION_KINDS: readonly SituationKind[] = ['unanswerable_question', 'waiting_stale']

/** How a card stopped being open: a person said yes or no, or its deadline passed. */
export type CardVerdict = 'approved' | 'rejected' | 'expired'

export interface CardVerdictInput {
  readonly situationKind: SituationKind
  readonly actionKind: ActionKind
  readonly verdict: CardVerdict
  /** The asking task is not done, failed or cancelled (a question with no task counts as live). */
  readonly askerTaskLive: boolean
  /** The asking run is paused `waiting_for_answer` on the question. */
  readonly askerParked: boolean
}

/**
 * Human cards H1 (plan A D4): what a card's verdict does to its question, as the reason it closes
 * with, or null when it stays open. An approved answer closes it itself (`answered`, in
 * `answerQuestion`). An approved re-address of a live asker's question keeps it open so the new
 * holder can answer it (ruling F18, amended: a finished task has nobody waiting on it). Any other
 * approval decides it, a rejection dismisses it, and an expiry times it out -- unless its asker is
 * parked on it, whose wait the timeout pass owns (ruling F6).
 */
export function questionCloseOnVerdict(input: CardVerdictInput): QuestionCloseReason | null {
  if (!isQuestionSituation(input.situationKind)) return null
  switch (input.verdict) {
    case 'rejected':
      return 'dismissed'
    case 'expired':
      return input.askerParked ? null : 'timed_out'
    case 'approved':
      if (input.actionKind === 'answer_question') return null
      if (
        input.askerTaskLive &&
        READDRESSING_ACTION_KINDS.includes(input.actionKind) &&
        READDRESSABLE_SITUATION_KINDS.includes(input.situationKind)
      ) {
        return null
      }
      return 'decided'
  }
}

/**
 * Spec §4: text a person wrote, on its way to a worker's prompt or the record -- storable (no NUL,
 * no C0 control but tab and newline), defused (markers and routing literals), trimmed and bounded.
 */
export function personText(raw: string, max: number = PERSON_CARD_TEXT_MAX_CHARS): string {
  return trimToFit(sanitisePersonText(storableText(raw)).trim(), max)
}

/** A wait in hours and minutes, at least one minute: "2 hours", "1 hour 30 minutes". */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const parts = [
    ...(hours === 0 ? [] : [`${String(hours)} hour${hours === 1 ? '' : 's'}`]),
    ...(rest === 0 ? [] : [`${String(rest)} minute${rest === 1 ? '' : 's'}`]),
  ]
  return parts.join(' ')
}

/** Spec H3 (plan A D8): what a run continued past its question timeout is told. */
export function timeoutResumeMessage(waitedMs: number, question: string): string {
  return trimToFit(
    [
      `No answer came in ${formatWait(waitedMs)}. Continue on your safest assumption, and say in your report which assumption you made.`,
      '',
      'You asked:',
      personText(question, PERSON_CARD_TEXT_MAX_CHARS),
    ].join('\n'),
    CLOSED_NOTE_MAX_CHARS,
  )
}

/** Spec H2.7: what a run is told when a person dismissed its question. */
export function dismissResumeMessage(reason: string | null): string {
  const said = reason === null ? '' : personText(reason)
  return `A person closed your question without an answer: ${said === '' ? 'no reason given' : said}. Continue on your safest assumption and say which in your report.`
}

/** Plan A D4: what a run is told when a person approved a card that sends it no answer. */
export const DECIDED_WITHOUT_ANSWER =
  'A person read your question and settled it without an answer for you. Continue on your safest assumption and say which in your report.'

/** Plan A D9: the hand-off a late answer becomes, addressed to the package that asked. */
export function lateAnswerChange(question: string, answer: string): string {
  return trimToFit(
    [
      'Your package asked a question and continued on its own assumption when no answer came. The answer arrived later.',
      `Question: ${personText(question, 600)}`,
      `Answer: ${personText(answer, 1000)}`,
      'Check your work against the answer, and change what it changes.',
    ].join('\n'),
    HANDOFF_CHANGE_MAX_CHARS,
  )
}
