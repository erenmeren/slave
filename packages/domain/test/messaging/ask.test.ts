import { describe, expect, it } from 'vitest'
import { ASK_BLOCK_CLOSE, ASK_BLOCK_OPEN, parseSlaveAsk } from '../../src/messaging/ask.js'

/** The shape a slave is told to emit: one JSON object between the two markers. */
const block = (json: string): string => `${ASK_BLOCK_OPEN}${json}${ASK_BLOCK_CLOSE}`

describe('parseSlaveAsk', () => {
  it('reads a role-addressed ask out of ordinary prose', () => {
    const parsed = parseSlaveAsk(
      `I cannot continue without knowing the retry queue.\n\n${block('{"role":"backend","question":"Which queue should retries land on?"}')}\n`,
    )
    expect(parsed).toEqual({
      kind: 'ask',
      ask: {
        recipientSlaveId: null,
        recipientRole: 'backend',
        question: 'Which queue should retries land on?',
        context: null,
      },
    })
  })

  it('reads a slave-addressed ask, with its optional context', () => {
    const parsed = parseSlaveAsk(block('{"slaveId":"maya","question":"Is the schema frozen?","context":"I am about to add a column."}'))
    expect(parsed).toEqual({
      kind: 'ask',
      ask: {
        recipientSlaveId: 'maya',
        recipientRole: null,
        question: 'Is the schema frozen?',
        context: 'I am about to add a column.',
      },
    })
  })

  it('takes the LAST block, the same last-object-wins rule the plan graph and the review verdict follow', () => {
    const parsed = parseSlaveAsk(
      `${block('{"role":"backend","question":"first draft"}')} then I thought again ${block('{"role":"backend","question":"the real one"}')}`,
    )
    expect(parsed.kind === 'ask' && parsed.ask.question).toBe('the real one')
  })

  it('reports an absent block as absent, not as malformed -- no block is the ordinary case', () => {
    expect(parseSlaveAsk('I finished the work and pushed the branch.')).toEqual({ kind: 'absent' })
    expect(parseSlaveAsk('')).toEqual({ kind: 'absent' })
  })

  it('refuses a block that is not JSON at all', () => {
    const parsed = parseSlaveAsk(block('who should I ask about the queue?'))
    expect(parsed.kind).toBe('malformed')
  })

  it('refuses an unterminated block', () => {
    const parsed = parseSlaveAsk(`${ASK_BLOCK_OPEN}{"role":"backend","question":"anyone?"}`)
    expect(parsed.kind).toBe('malformed')
  })

  it('refuses a block with no question, or an empty one', () => {
    expect(parseSlaveAsk(block('{"role":"backend"}')).kind).toBe('malformed')
    expect(parseSlaveAsk(block('{"role":"backend","question":"   "}')).kind).toBe('malformed')
  })

  it('refuses both recipients at once, and neither -- `isValidRecipient`, applied to model output', () => {
    expect(parseSlaveAsk(block('{"role":"backend","slaveId":"maya","question":"who?"}')).kind).toBe('malformed')
    expect(parseSlaveAsk(block('{"question":"who?"}')).kind).toBe('malformed')
  })

  it('refuses a non-object body -- an array or a bare string is not an envelope', () => {
    expect(parseSlaveAsk(block('["role","backend"]')).kind).toBe('malformed')
    expect(parseSlaveAsk(block('"backend"')).kind).toBe('malformed')
  })
})
