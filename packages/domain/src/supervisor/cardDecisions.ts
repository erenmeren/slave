import { z } from 'zod'
import { HANDOFF_CHANGE_MAX_CHARS, SHARED_DECISION_TEXT_MAX_CHARS, SHARED_DECISION_TITLE_MAX_CHARS } from '../conduct/constants.js'
import { trimToFit } from '../conduct/verification.js'
import { CLOSED_NOTE_MAX_CHARS, PERSON_CARD_TEXT_MAX_CHARS, type QuestionCloseReason } from '../messaging/close.js'
import type { Action } from './actions.js'
import { dismissResumeMessage, personText, type LateAnswerFate } from './cards.js'

/** Human-cards spec H2: the decisions a question card can carry, in the order a card offers them. */
export const CARD_DECISION_KINDS = ['send_answer', 'write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'] as const
export type CardDecisionKind = (typeof CARD_DECISION_KINDS)[number]

export type CardDecision =
  | { readonly kind: 'send_answer' }
  | { readonly kind: 'write_answer'; readonly body: string }
  | { readonly kind: 'give_work'; readonly target: { readonly package: string } | { readonly path: string }; readonly request: string }
  | { readonly kind: 'give_file'; readonly path: string; readonly toPackage: string }
  | { readonly kind: 'record_decision'; readonly title: string; readonly text: string }
  | { readonly kind: 'change_requirement'; readonly request: string }
  | { readonly kind: 'dismiss'; readonly reason: string | null }

/** The bound on a path a card decision names (`give_work`'s file target, `give_file`'s file), shared
 *  with the card's form in the browser so the limit a person is shown is the one the route enforces. */
export const CARD_PATH_MAX_CHARS = 500
/** The bound on a package key a card decision names -- the same sharing as {@link CARD_PATH_MAX_CHARS}. */
export const CARD_PACKAGE_KEY_MAX_CHARS = 40

const text = (max: number): z.ZodString => z.string().trim().min(1).max(max)

/** Plan B D1: the one validator of a card decision -- the route's 400 and `decideCard`'s own check. */
export const cardDecisionSchema: z.ZodType<CardDecision, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send_answer') }).strict(),
  z.object({ kind: z.literal('write_answer'), body: text(PERSON_CARD_TEXT_MAX_CHARS) }).strict(),
  z
    .object({
      kind: z.literal('give_work'),
      // Exactly one of a package or a path: a path is resolved to its owner by `resolveHandOff`.
      target: z.union([z.object({ package: text(CARD_PACKAGE_KEY_MAX_CHARS) }).strict(), z.object({ path: text(CARD_PATH_MAX_CHARS) }).strict()]),
      request: text(HANDOFF_CHANGE_MAX_CHARS),
    })
    .strict(),
  z.object({ kind: z.literal('give_file'), path: text(CARD_PATH_MAX_CHARS), toPackage: text(CARD_PACKAGE_KEY_MAX_CHARS) }).strict(),
  z.object({ kind: z.literal('record_decision'), title: text(SHARED_DECISION_TITLE_MAX_CHARS), text: text(SHARED_DECISION_TEXT_MAX_CHARS) }).strict(),
  z.object({ kind: z.literal('change_requirement'), request: text(PERSON_CARD_TEXT_MAX_CHARS) }).strict(),
  z.object({ kind: z.literal('dismiss'), reason: z.string().trim().max(PERSON_CARD_TEXT_MAX_CHARS).nullable() }).strict(),
]) as z.ZodType<CardDecision, z.ZodTypeDef, unknown>

/** Plan B D3: what a card records about a person's decision. */
export interface PersonDecision {
  readonly decision: CardDecision
  readonly goalVersion: number | null
  /** A user id, or `operator`. */
  readonly by: string
  readonly at: string
  /** {@link personDecisionSummary}: the one sentence the report and the event's note carry. */
  readonly summary: string
  /** A file grant's move, as it was made. */
  readonly grant?: { readonly path: string; readonly fromKey: string | null; readonly toKey: string } | undefined
}

/** Plan B D3: `SupervisorDecision.personDecision` read back -- a row that fails it is reported as unreadable, never trusted. */
export const personDecisionSchema: z.ZodType<PersonDecision, z.ZodTypeDef, unknown> = z.object({
  decision: cardDecisionSchema,
  goalVersion: z.number().int().positive().nullable(),
  by: z.string().min(1).max(200),
  at: z.string().min(1),
  summary: z.string().min(1).max(500),
  grant: z.object({ path: z.string().min(1), fromKey: z.string().nullable(), toKey: z.string().min(1) }).optional(),
})

/**
 * Plan B D7: the decisions that fit a card, in {@link CARD_DECISION_KINDS} order. A question closed
 * any way but a timeout takes none; one that timed out still takes all but an answer no run would
 * read (ruling F37: with `lateAnswerFate` `unread` an answer would retire the card while nobody reads
 * it). `lateAnswerFate` is read only for a `timed_out` question; it is required (Task 3 carry) so no
 * caller can leave it out -- `QuestionCard.lateAnswerFate` is the value to pass.
 */
export function cardOffers(input: {
  readonly actionKind: Action['kind']
  readonly hasDraftBody: boolean
  readonly closedReason: QuestionCloseReason | null
  readonly hasPackages: boolean
  readonly lateAnswerFate: LateAnswerFate | null
}): readonly CardDecisionKind[] {
  if (input.closedReason !== null && input.closedReason !== 'timed_out') return []
  const answerUnread = input.closedReason === 'timed_out' && input.lateAnswerFate === 'unread'
  return CARD_DECISION_KINDS.filter((kind) => {
    if (kind === 'send_answer') return !answerUnread && input.actionKind === 'answer_question' && input.hasDraftBody
    if (kind === 'write_answer') return !answerUnread
    if (kind === 'give_work' || kind === 'give_file' || kind === 'record_decision') return input.hasPackages
    return true
  })
}

const pkgName = (key: string | null): string => (key === null ? 'another' : `the ${personText(key, 40)}`)

/** Plan B D3: the one sentence a person's decision is recorded and reported as. */
export function personDecisionSummary(decision: CardDecision, target: { readonly packageKey: string | null }): string {
  switch (decision.kind) {
    case 'send_answer':
      return 'sent the drafted answer'
    case 'write_answer':
      return 'answered in their own words'
    case 'give_work':
      return `gave ${pkgName(target.packageKey)} package work: ${personText(decision.request, 300)}`
    case 'give_file':
      return `gave ${personText(decision.path, 200)} to ${pkgName(decision.toPackage)} package`
    case 'record_decision':
      return `recorded the shared decision "${personText(decision.title, 80)}"`
    case 'change_requirement':
      return `changed a requirement: ${personText(decision.request, 300)}`
    case 'dismiss':
      return decision.reason === null || personText(decision.reason) === '' ? 'dismissed the question' : `dismissed the question: ${personText(decision.reason, 300)}`
  }
}

/**
 * Plan B D3: what a parked asker continues with once a person decided its question without an
 * answer. `packageKey` is the package the decision names (`give_work`'s resolved target, the
 * package `give_file` gives to); `askerPackageKey` is the asking task's own package -- work or a
 * file given to it is the asker's (ruling F57), so it is never told to leave it alone. Bounded to
 * `closedNote` (ruling F69).
 */
export function decidedResumeMessage(decision: CardDecision, target: { readonly packageKey: string | null; readonly askerPackageKey: string | null }): string {
  return trimToFit(decidedResumeText(decision, target), CLOSED_NOTE_MAX_CHARS)
}

function decidedResumeText(decision: CardDecision, target: { readonly packageKey: string | null; readonly askerPackageKey: string | null }): string {
  switch (decision.kind) {
    case 'give_work':
      if (target.packageKey !== null && target.packageKey === target.askerPackageKey) {
        return `A person asks you to do this: ${personText(decision.request)}. Do it along with the rest of your work, and say in your report what you did.`
      }
      return `A person decided on your question: ${pkgName(target.packageKey)} package will do this: ${personText(decision.request)}. Do not make that change yourself; continue with the rest, and say in your report what you left to it.`
    case 'give_file':
      // As ruling F57 words give_work: a file given to the asker's own package is its to change.
      if (target.packageKey !== null && target.packageKey === target.askerPackageKey) {
        return `A person gave your package ${personText(decision.path, 200)}: it is yours to change from your next run. Continue with your work, and say in your report what you changed in it.`
      }
      return `A person decided on your question: ${personText(decision.path, 200)} now belongs to ${pkgName(decision.toPackage)} package. Continue with the rest, and say in your report what you left to it.`
    case 'record_decision':
      return `A person recorded a shared decision for your goal version: "${personText(decision.title, 80)}" -- ${personText(decision.text, 600)}. Continue with it.`
    case 'change_requirement':
      return `A person changed the requirements in answer to your question: ${personText(decision.request)}. A new goal version will be planned from it; finish what you can and say in your report what the change leaves undone.`
    case 'dismiss':
      return dismissResumeMessage(decision.reason)
    case 'send_answer':
    case 'write_answer':
      // An answer is delivered as itself (`deliverAnswers`); this text is never sent for one.
      return 'A person answered your question.'
  }
}
