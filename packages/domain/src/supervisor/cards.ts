import { HANDOFF_CHANGE_MAX_CHARS } from '../conduct/constants.js'
import { storableText } from '../conduct/storable.js'
import { trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { CLOSED_NOTE_MAX_CHARS, PERSON_CARD_TEXT_MAX_CHARS } from '../messaging/close.js'
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
