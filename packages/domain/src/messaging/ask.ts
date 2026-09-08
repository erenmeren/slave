import { z } from 'zod'
import { isValidRecipient } from './types.js'

/**
 * The markers a slave wraps its ask in (M36 t2).
 *
 * A dedicated marker rather than the `jsonObjectsLastToFirst` "last JSON object wins" convention
 * `parsePlanGraph`/`parseReviewVerdict` use. Those two run against a run whose ENTIRE purpose was
 * to produce that object -- a planning run's output is a plan, a review run's is a verdict -- so
 * the last object in it is unambiguously the answer. This parser runs against EVERY implementation
 * run's output, where an object carrying `role` and `question` keys may well be a fragment of the
 * work itself (a fixture, a schema, a test the slave just wrote). Scanning for bare JSON there
 * would park a task the moment a slave echoed the wrong file back. The marker is the difference
 * between "an object that happens to fit" and "the slave deliberately asked".
 *
 * Between them: ONE JSON object, no code fence of its own (a fence around the whole marked block
 * is harmless -- the markers are found inside it either way).
 */
export const ASK_BLOCK_OPEN = '<slave-ask>'
export const ASK_BLOCK_CLOSE = '</slave-ask>'

/** A parsed, structurally valid ask. Whether the recipient EXISTS is a database question, and
 *  deliberately not this module's: `apps/orchestrator/src/ask.ts` answers it, scoped to the
 *  sending run's own workspace. */
export interface SlaveAsk {
  /** Set when the ask names one slave; `null` when it names a role. Never both, never neither. */
  readonly recipientSlaveId: string | null
  readonly recipientRole: string | null
  readonly question: string
  /** Anything the asker wants the answerer to know first. Optional, and absent is `null`. */
  readonly context: string | null
}

/**
 * Three outcomes, named rather than collapsed into a `Result`. `absent` and `malformed` both end
 * the run the ordinary way, but they are not the same fact: no block is what every run that did
 * not ask produces, while a malformed one is a slave that TRIED to ask and got the shape wrong --
 * §13's "no failure is silent" applies to the second and would be noise for the first.
 */
export type AskParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'ask'; readonly ask: SlaveAsk }

/**
 * The envelope, as the model writes it. `slaveId`/`role` rather than `recipientSlaveId`/
 * `recipientRole`: this is the shape a slave types, and the prompt that teaches it is shorter for
 * it. The mapping to the message's own field names happens once, below.
 *
 * Unknown keys are tolerated (no `.strict()`), the same latitude `planTaskSchema` and
 * `reviewVerdictSchema` give: an extra key is a model being chatty, not a different intent, and
 * refusing one would spend a run's whole outcome on a stray field.
 */
export const slaveAskSchema = z.object({
  slaveId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  question: z.string().min(1),
  context: z.string().min(1).optional(),
})

/**
 * Reads the LAST ask block out of a run's own output text (M36 t2).
 *
 * Last-block-wins, the same rule the other two model-output parsers in this package follow: a
 * slave that drafts an ask, thinks again and writes another has answered its own first draft, and
 * the one it finished with is the one it meant.
 *
 * Nothing here reaches the database. This is the zod boundary the milestone's constraint names --
 * free-form model output never mutates state -- and `sendMessage` (which does no runtime
 * validation of its own) is only ever handed the object this function returns.
 */
export function parseSlaveAsk(text: string): AskParse {
  const open = text.lastIndexOf(ASK_BLOCK_OPEN)
  if (open === -1) return { kind: 'absent' }

  const from = open + ASK_BLOCK_OPEN.length
  const close = text.indexOf(ASK_BLOCK_CLOSE, from)
  if (close === -1) {
    // Not `absent`: the slave opened an ask and never closed it. Reported, because a run that
    // meant to wait and instead concluded is exactly the confusion §13 exists to prevent.
    return { kind: 'malformed', reason: `an ${ASK_BLOCK_OPEN} block was never closed with ${ASK_BLOCK_CLOSE}` }
  }

  const body = text.slice(from, close).trim()
  let candidate: unknown
  try {
    candidate = JSON.parse(body)
  } catch (error) {
    return { kind: 'malformed', reason: `the ask block is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  const parsed = slaveAskSchema.safeParse(candidate)
  if (!parsed.success) {
    return { kind: 'malformed', reason: `the ask block does not fit the envelope: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }
  }

  const recipientSlaveId = parsed.data.slaveId ?? null
  const recipientRole = parsed.data.role ?? null
  // The same predicate `sendMessage` applies to its own callers -- both-or-neither identifies
  // nobody, or is ambiguous about who should answer.
  if (!isValidRecipient({ slaveId: recipientSlaveId, role: recipientRole })) {
    return { kind: 'malformed', reason: 'an ask must name exactly one of slaveId or role' }
  }
  if (parsed.data.question.trim() === '') {
    return { kind: 'malformed', reason: 'an ask must carry a question' }
  }

  return {
    kind: 'ask',
    ask: {
      recipientSlaveId,
      recipientRole,
      question: parsed.data.question.trim(),
      context: parsed.data.context?.trim() ?? null,
    },
  }
}
