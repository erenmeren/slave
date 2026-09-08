import { describe, expect, it } from 'vitest'
import { ANSWER_BLOCK_CLOSE, ANSWER_BLOCK_OPEN, parseSlaveAnswers } from '../../src/messaging/answer.js'

/** The shape a slave is told to emit: one JSON object between the two markers, once per answer. */
const block = (json: string): string => `${ANSWER_BLOCK_OPEN}${json}${ANSWER_BLOCK_CLOSE}`

describe('parseSlaveAnswers', () => {
  it('finds nothing in output that carries no block', () => {
    expect(parseSlaveAnswers('I read the file and changed the retry count.')).toEqual({ answers: [], malformed: [] })
  })

  it('reads one answer out of ordinary prose', () => {
    expect(parseSlaveAnswers(`Sure.\n\n${block('{"messageId":"m-1","answer":"The retries land on payments-retry."}')}\n`)).toEqual({
      answers: [{ messageId: 'm-1', answer: 'The retries land on payments-retry.' }],
      malformed: [],
    })
  })

  it('reads every block, so a slave with two pending questions can answer both', () => {
    const text = `${block('{"messageId":"m-1","answer":"queue A"}')}\nand\n${block('{"messageId":"m-2","answer":"three times"}')}`
    expect(parseSlaveAnswers(text).answers).toEqual([
      { messageId: 'm-1', answer: 'queue A' },
      { messageId: 'm-2', answer: 'three times' },
    ])
  })

  it('keeps the LAST answer when the same question is answered twice -- the slave thought again', () => {
    const text = `${block('{"messageId":"m-1","answer":"queue A"}')}\nno, wait\n${block('{"messageId":"m-1","answer":"queue B"}')}`
    expect(parseSlaveAnswers(text).answers).toEqual([{ messageId: 'm-1', answer: 'queue B' }])
  })

  it('reports a block that is not JSON, and keeps the well-formed ones around it', () => {
    const parsed = parseSlaveAnswers(`${block('queue A')}\n${block('{"messageId":"m-2","answer":"queue B"}')}`)
    expect(parsed.answers).toEqual([{ messageId: 'm-2', answer: 'queue B' }])
    expect(parsed.malformed).toHaveLength(1)
    expect(parsed.malformed[0]).toMatch(/not JSON/)
  })

  it('reports a block that does not fit the envelope', () => {
    const parsed = parseSlaveAnswers(block('{"answer":"queue A"}'))
    expect(parsed.answers).toEqual([])
    expect(parsed.malformed[0]).toMatch(/messageId/)
  })

  it('reports an answer that is only whitespace rather than sending an empty message', () => {
    const parsed = parseSlaveAnswers(block('{"messageId":"m-1","answer":"   "}'))
    expect(parsed.answers).toEqual([])
    expect(parsed.malformed).toHaveLength(1)
  })

  it('reports an unclosed block instead of silently ignoring it', () => {
    const parsed = parseSlaveAnswers(`${ANSWER_BLOCK_OPEN}{"messageId":"m-1","answer":"queue A"}`)
    expect(parsed.answers).toEqual([])
    expect(parsed.malformed[0]).toMatch(/never closed/)
  })

  it('tolerates an unknown key, the same latitude the ask envelope gives', () => {
    expect(parseSlaveAnswers(block('{"messageId":"m-1","answer":"queue A","confidence":"high"}')).answers).toEqual([
      { messageId: 'm-1', answer: 'queue A' },
    ])
  })
})
