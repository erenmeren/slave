import { describe, expect, it } from 'vitest'
import { OUTPUT_CAP, OUTPUT_ROWS_MAX, joinRunOutput, splitRunOutput } from '../src/runOutput.js'

/**
 * The two halves of one contract, tested together on purpose.
 *
 * `run.output` rows are the ONLY source `concludePlanning`, `concludeReview` and `concludeReplan`
 * have for the text they parse, and the cap that keeps one row readable used to drop everything
 * past it. A plan is always longer than the cap, so every real first plan was refused with "no JSON
 * object with { "tasks": [...] } found" while the model had in fact produced one. Splitting and
 * rejoining have to be exact inverses, or that failure comes back in a subtler form.
 */
describe('splitRunOutput / joinRunOutput', () => {
  it('leaves text that fits the cap as ONE payload that continues nothing', () => {
    const payloads = splitRunOutput('a short answer')
    expect(payloads).toEqual([{ text: 'a short answer' }])
  })

  it('leaves text of exactly the cap alone: an off-by-one here splits what already fitted', () => {
    const exact = 'y'.repeat(OUTPUT_CAP)
    expect(splitRunOutput(exact)).toEqual([{ text: exact }])
  })

  it('keeps every row within the cap, which is what the cap is for', () => {
    for (const payload of splitRunOutput('x'.repeat(OUTPUT_CAP * 3 + 7))) {
      expect(payload.text.length).toBeLessThanOrEqual(OUTPUT_CAP)
    }
  })

  it('loses NOTHING: the rejoined text is the text that went in, to the character', () => {
    // The head-and-tail markers are what tell "kept the beginning" from "kept everything": a
    // string of one repeated character cannot fail this test.
    const original = `HEAD${'x'.repeat(OUTPUT_CAP * 2)}TAIL`
    expect(joinRunOutput(splitRunOutput(original))).toBe(original)
  })

  it('rejoins a JSON object split ACROSS a boundary, including one split inside a string', () => {
    // The whole point. A plan graph is one long message, so the split lands wherever it lands --
    // and a newline injected inside a JSON string literal is a control character that makes the
    // object unparsable, which is why continuation chunks must rejoin with nothing between them.
    const graph = JSON.stringify({ tasks: [{ key: 'k', title: 'T'.repeat(OUTPUT_CAP + 50) }] })
    const rejoined = joinRunOutput(splitRunOutput(graph))
    expect(rejoined).toBe(graph)
    expect(JSON.parse(rejoined)).toEqual({ tasks: [{ key: 'k', title: 'T'.repeat(OUTPUT_CAP + 50) }] })
  })

  it('never splits a surrogate pair, which jsonb cannot store half of', () => {
    // A lone surrogate is not storable: `JSON.stringify` escapes it and Postgres refuses the
    // escape outright, so a boundary landing mid-pair would not truncate a row -- it would throw
    // and lose the entire run's conclusion.
    const emoji = '😀'
    const original = `${'a'.repeat(OUTPUT_CAP - 1)}${emoji}${'b'.repeat(10)}`
    const payloads = splitRunOutput(original)
    for (const payload of payloads) {
      expect(payload.text).toBe(payload.text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/gu, '?'))
      expect(payload.text).toBe(payload.text.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '?'))
    }
    expect(joinRunOutput(payloads)).toBe(original)
  })

  it('stops at the row ceiling and SAYS the rest was dropped, so a runaway cannot flood the log', () => {
    // The protection the old truncation was written for, kept: splitting without a ceiling turns
    // one unreadable row into thousands. Far above any real answer, so nothing that matters is
    // reached by it.
    const payloads = splitRunOutput('z'.repeat(OUTPUT_CAP * OUTPUT_ROWS_MAX * 3))
    expect(payloads).toHaveLength(OUTPUT_ROWS_MAX)
    expect(payloads.at(-1)?.text.endsWith('…')).toBe(true)
    expect(payloads.at(-1)?.continues).toBeUndefined()
    for (const payload of payloads) expect(payload.text.length).toBeLessThanOrEqual(OUTPUT_CAP)
  })

  it('separates DISTINCT messages with a newline, as the readers always have', () => {
    // Two `text` events are two things the slave said, and a parser looking for one JSON object
    // among them must not be handed them welded into a single line.
    expect(joinRunOutput([{ text: 'first' }, { text: 'second' }])).toBe('first\nsecond')
  })

  it('reads rows written BEFORE this contract existed, which carry no continuation flag', () => {
    // Every `run.output` already in the log is `{ text }`. They are complete messages by
    // definition -- whatever was cut from them is gone -- and must keep joining as they did.
    expect(joinRunOutput([{ text: 'old one' }, { text: 'old two' }])).toBe('old one\nold two')
  })

  it('ignores a row whose payload is not shaped like output rather than throwing', () => {
    // The log is append-only and older than this code. A row nothing can read is not a reason to
    // abandon a run's conclusion.
    expect(joinRunOutput([{ text: 'kept' }, null, { nope: 1 }, { text: 'also kept' }])).toBe('kept\nalso kept')
  })
})
