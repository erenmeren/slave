import { z } from 'zod'
import { firstJsonObject } from '../supervisor/prompt.js'
import { INTAKE_TEXT_MAX_CHARS } from './constants.js'
import { intakeDraftSchema, type IntakeDraft } from './draft.js'
import type { IntakeFacts } from './facts.js'

/**
 * The model's answer (M59 R9): a question, or a question with a draft attached.
 *
 * `text` is what the conversation SHOWS in both arms, which is why the draft arm carries one too --
 * a card that appeared with no sentence beside it would be a form that arrived from nowhere.
 */
export const intakeAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), text: z.string().trim().min(1).max(INTAKE_TEXT_MAX_CHARS) }),
  z.object({
    kind: z.literal('draft'),
    text: z.string().trim().min(1).max(INTAKE_TEXT_MAX_CHARS),
    draft: intakeDraftSchema,
  }),
])

export type IntakeAnswer = z.infer<typeof intakeAnswerSchema>

/** The envelope. The key is the literal `INTAKE_ANSWER_MARKER` (`./prompt.js`) the prompt asks for
 *  and the fake CLI keys on, so the marker is STRUCTURAL rather than decorative: an answer that
 *  does not carry it is not an answer this system will read. */
const envelopeSchema = z.object({ intakeAnswer: intakeAnswerSchema })

export interface ParsedIntakeAnswer {
  readonly answer: IntakeAnswer
  /** Why a draft was downgraded to a question, or null. Recorded on the intake so an operator can
   *  find out why the card they expected did not appear. */
  readonly downgraded: string | null
}

/**
 * Which rule the draft broke, or null (M59 R9). Checked AFTER the schema parse, because these are
 * claims about the world rather than about the shape.
 */
function draftBreach(draft: IntakeDraft, facts: IntakeFacts | null): string | null {
  const detected = new Set((facts?.paths ?? []).flatMap((path) => path.verify.map((finding) => finding.command)))
  for (const entry of draft.verifyCommands) {
    if (entry.source === 'operator') {
      return `the model marked "${entry.command}" as typed by the operator, which only a person can be`
    }
    if (entry.source === 'detected' && !detected.has(entry.command)) {
      return `"${entry.command}" is marked as detected and was not found in any repository`
    }
    if (entry.source === 'draft' && draft.repo.mode !== 'new') {
      return `"${entry.command}" is marked as a proposal, and this project uses a repository that already exists`
    }
  }
  return null
}

/**
 * Reads a model's answer, or refuses it (M59 R9).
 *
 * `null` means "the model did not answer" -- unparseable, no JSON, or an envelope without the
 * marker -- and the caller records a sentence saying so rather than an action, exactly as
 * `parseDecisionAnswer`'s null falls back to the rules.
 *
 * Only the FIRST JSON object is considered, `firstJsonObject`'s own rule and for its own reason:
 * scanning on would let a model that printed a bad answer first have a second go at the same
 * prompt.
 *
 * A draft that breaks a source rule is DOWNGRADED rather than dropped: the answer becomes the
 * `ask` the model already wrote, the conversation keeps going, and a hallucinated command never
 * reaches the card. Dropping it entirely would cost the person a turn and tell them nothing.
 */
export function parseIntakeAnswer(text: string, facts: IntakeFacts | null): ParsedIntakeAnswer | null {
  const source = firstJsonObject(text)
  if (source === null) return null

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }

  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) return null
  const answer = envelope.data.intakeAnswer
  if (answer.kind === 'ask') return { answer, downgraded: null }

  const breach = draftBreach(answer.draft, facts)
  if (breach === null) return { answer, downgraded: null }
  return { answer: { kind: 'ask', text: answer.text }, downgraded: breach }
}
