/**
 * The `run.output` contract: how a slave's text is written to the log, and how a parser reads it
 * back.
 *
 * Both halves live here because they are one decision. The log is the ONLY source
 * `concludePlanning`, `concludeReview` and `concludeReplan` have for the text they parse -- they
 * run from `verifyConcludedRun`, which is deliberately decoupled from the pump (it is also reached
 * from `resume.ts`, where no in-memory stream text exists at all) -- so whatever the writer drops,
 * the reader can never see.
 */

/**
 * The cap on a single `run.output` payload (spec §9: the slave's text output "with a truncation
 * cap"). It protects an append-only log first and a screen second -- one runaway paste from a
 * model that decided to echo a file back is otherwise a row nobody can read and nobody can delete.
 *
 * A cap on the ROW, not on the message. {@link splitRunOutput} keeps every row within it while
 * still writing all of the text, which is what makes the log readable AND faithful.
 */
export const OUTPUT_CAP = 4_000

/**
 * How many rows one message may occupy before the rest really is dropped.
 *
 * Splitting instead of truncating gives back the protection the cap was written for only if there
 * is still a ceiling: a model that decides to echo a 10 MB file would otherwise turn one
 * unreadable row into two and a half thousand of them, which is worse for an append-only log than
 * the truncation this replaced.
 *
 * Sixteen rows is 64 000 characters. A planning graph -- the longest thing anything parses back
 * out of this log, and the reason for the split -- runs to a few thousand, so the ceiling is far
 * above every real answer and far below a runaway.
 */
export const OUTPUT_ROWS_MAX = 16

export interface RunOutputPayload {
  readonly text: string
  /**
   * This row is not the end of the message: the next `run.output` row continues it with nothing in
   * between.
   *
   * Absent on a message that fitted the cap and absent on every row written before this contract
   * existed -- which is exactly right, because those are complete messages as far as anything can
   * now tell. {@link joinRunOutput} reads it to decide between welding two rows together and
   * separating two things the slave said.
   */
  readonly continues?: boolean
}

/**
 * One message, as the rows that will carry it.
 *
 * Chunked rather than truncated, which is a reversal of the earlier decision to keep the beginning
 * and drop the rest. The reason the earlier one was wrong: a planning run's answer is a single
 * message far longer than the cap, `concludePlanning` parses it back out of these rows, and a
 * `{"tasks":[...]}` graph cut at 4 000 characters is not a shorter graph -- it is unparsable JSON.
 * Every real first plan failed that way, with the model's own correct answer in the log, halved.
 *
 * Splitting on a code point boundary, never mid-pair: `JSON.stringify` turns a lone surrogate into
 * an escape Postgres refuses outright, so a careless boundary would not shorten a row -- it would
 * throw and lose the whole conclusion.
 */
export function splitRunOutput(text: string): readonly RunOutputPayload[] {
  if (text.length <= OUTPUT_CAP) return [{ text }]
  const payloads: RunOutputPayload[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(at + OUTPUT_CAP, text.length)
    // A high surrogate at the last position has its pair in the next chunk: keep them together by
    // giving this row one character less.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
    const chunk = text.slice(at, end)
    at = end
    // The ceiling. The last row it allows is truncated in the old sense -- and *says* it was cut,
    // because a sentence that simply stops reads as the slave having stopped.
    if (payloads.length === OUTPUT_ROWS_MAX - 1 && at < text.length) {
      payloads.push({ text: `${chunk.slice(0, OUTPUT_CAP - 1)}…` })
      return payloads
    }
    payloads.push(at < text.length ? { text: chunk, continues: true } : { text: chunk })
  }
  return payloads
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * The rows of a run, as the text the slave actually produced.
 *
 * Continuation rows are welded with NOTHING between them -- a newline inside a JSON string literal
 * is a control character, and injecting one would make an object that was split mid-string
 * unparsable, which is the failure this whole contract exists to prevent. Distinct messages keep
 * the newline the readers have always joined them with.
 *
 * Takes unknown payloads and skips what it cannot read: the log is append-only and older than this
 * code, and one unreadable row is not a reason to abandon a run's conclusion.
 */
export function joinRunOutput(payloads: readonly unknown[]): string {
  let text = ''
  let continues = false
  for (const payload of payloads) {
    const value = asPayload(payload)
    if (value === null) continue
    if (text !== '' && !continues) text += '\n'
    text += value.text
    continues = value.continues === true
  }
  return text
}

function asPayload(payload: unknown): RunOutputPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = payload as { text?: unknown; continues?: unknown }
  if (typeof value.text !== 'string') return null
  return value.continues === true ? { text: value.text, continues: true } : { text: value.text }
}
