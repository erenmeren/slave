import { z } from 'zod'

/**
 * The markers a slave wraps an answer in (M36 t3) -- the mirror of `ASK_BLOCK_OPEN`/
 * `ASK_BLOCK_CLOSE` in `./ask.js`, and a dedicated marker for the same reason: this parser runs
 * against EVERY implementation run's output, where an object carrying `messageId` and `answer`
 * keys may well be a fragment of the work itself. The marker is the difference between "an object
 * that happens to fit" and "the slave deliberately answered".
 *
 * Between them: ONE JSON object, no code fence of its own.
 */
export const ANSWER_BLOCK_OPEN = '<slave-answer>'
export const ANSWER_BLOCK_CLOSE = '</slave-answer>'

/**
 * A parsed, structurally valid answer. Whether `messageId` names a real question, addressed to
 * this slave, in its own workspace, is a database question and deliberately not this module's:
 * `apps/orchestrator/src/answer.ts` answers it, scoped to the answering run's own workspace.
 */
export interface SlaveAnswer {
  readonly messageId: string
  readonly answer: string
}

/**
 * Every well-formed answer in a run's output, plus a reason for each block that was not one.
 *
 * A LIST, unlike `parseSlaveAsk`'s single result: a run's prompt carries every unanswered question
 * addressed to that slave (`apps/orchestrator/src/inbox.ts`), so a slave with two pending questions
 * is expected to write two blocks, and last-block-wins would silently drop one of the two answers
 * somebody is waiting on.
 *
 * `malformed` is kept rather than collapsed into the absence of an answer for §13's reason: a slave
 * that TRIED to answer and got the shape wrong leaves an asker waiting forever, and that deserves a
 * line in the log. Both lists empty is the ordinary shape of every run that answered nobody.
 */
export interface SlaveAnswerParse {
  readonly answers: readonly SlaveAnswer[]
  readonly malformed: readonly string[]
}

/**
 * The envelope, as the model writes it. `messageId` is the id the run's own prompt listed beside
 * the question -- the slave never invents one, it echoes one back.
 *
 * Unknown keys are tolerated (no `.strict()`), the same latitude `slaveAskSchema` gives: an extra
 * key is a model being chatty, not a different intent.
 */
export const slaveAnswerSchema = z.object({
  messageId: z.string().min(1),
  answer: z.string().min(1),
})

/**
 * Reads every answer block out of a run's own output text (M36 t3).
 *
 * Nothing here reaches the database. This is the zod boundary the milestone's constraint names --
 * free-form model output never mutates state -- and `sendMessage` (which does no runtime validation
 * of its own) is only ever handed objects this function returns.
 *
 * Later wins for a REPEATED `messageId`: a slave that drafts an answer, thinks again and writes
 * another has answered its own first draft. Order otherwise follows the text, so two answers to two
 * different questions are sent in the order the slave wrote them.
 */
export function parseSlaveAnswers(text: string): SlaveAnswerParse {
  // A Map keyed by `messageId`, so "later wins" is the insertion behaviour rather than a second
  // pass: `Map.set` on an existing key overwrites the value and KEEPS the original position, which
  // is the order the slave first meant to answer in.
  const answers = new Map<string, SlaveAnswer>()
  const malformed: string[] = []

  let cursor = 0
  for (;;) {
    const open = text.indexOf(ANSWER_BLOCK_OPEN, cursor)
    if (open === -1) break
    const from = open + ANSWER_BLOCK_OPEN.length
    const close = text.indexOf(ANSWER_BLOCK_CLOSE, from)
    if (close === -1) {
      // Not silence: the slave opened an answer and never closed it, and somebody is waiting on it.
      malformed.push(`an ${ANSWER_BLOCK_OPEN} block was never closed with ${ANSWER_BLOCK_CLOSE}`)
      break
    }
    cursor = close + ANSWER_BLOCK_CLOSE.length

    const body = text.slice(from, close).trim()
    let candidate: unknown
    try {
      candidate = JSON.parse(body)
    } catch (error) {
      malformed.push(`an answer block is not JSON: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const parsed = slaveAnswerSchema.safeParse(candidate)
    if (!parsed.success) {
      malformed.push(
        `an answer block does not fit the envelope: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      )
      continue
    }
    const answer = parsed.data.answer.trim()
    if (answer === '') {
      // `min(1)` above passes for `"   "`, and an empty body is refused by `sendMessage` anyway --
      // reported here so the reason names the block rather than surfacing as a control refusal.
      malformed.push(`the answer to ${parsed.data.messageId} is blank`)
      continue
    }
    answers.set(parsed.data.messageId, { messageId: parsed.data.messageId, answer })
  }

  return { answers: [...answers.values()], malformed }
}
