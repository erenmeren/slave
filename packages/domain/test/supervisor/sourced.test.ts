import { describe, expect, it } from 'vitest'
import type { Source } from '../../src/supervisor/answerPrompt.js'
import { isSourced, verifySources } from '../../src/supervisor/sourced.js'
import { question, slave, threadMessage, world } from './fixtures.js'

const WORLD = world({ goal: 'Ship the invoicing service by October', slaves: [slave()] })

const QUESTION = question({
  taskTitle: 'Wire the reader',
  taskDescription: 'Connect to PostgreSQL on port 5433.',
  askerRunPrompt: 'You are Alex, a backend engineer. The datastore is Postgres.',
  thread: [
    threadMessage({ messageId: 'm1', body: 'Which port does the database listen on?' }),
    threadMessage({ messageId: 'm2', kind: 'note', body: 'The staging box answers on 6000.' }),
  ],
})

const source = (overrides: Partial<Source> = {}): Source => ({ kind: 'task', ref: null, quote: 'x', ...overrides })

describe('verifySources -- what verifies', () => {
  it('accepts a quote from the task title and from the task description', () => {
    const sources = [source({ quote: 'Wire the reader' }), source({ quote: 'PostgreSQL on port 5433' })]
    const result = verifySources(sources, QUESTION, WORLD)
    expect(result.verified).toEqual(sources)
    expect(result.rejected).toEqual([])
  })

  it('accepts a quote from the workspace goal', () => {
    const result = verifySources([source({ kind: 'goal', quote: 'by October' })], QUESTION, WORLD)
    expect(result.verified).toHaveLength(1)
    expect(result.rejected).toEqual([])
  })

  it("accepts a quote from the asker run's recorded prompt", () => {
    const result = verifySources([source({ kind: 'run_context', quote: 'The datastore is Postgres' })], QUESTION, WORLD)
    expect(result.verified).toHaveLength(1)
    expect(result.rejected).toEqual([])
  })

  it('accepts a quote from the thread message its ref names', () => {
    const result = verifySources([source({ kind: 'message', ref: 'm2', quote: 'answers on 6000' })], QUESTION, WORLD)
    expect(result.verified).toHaveLength(1)
    expect(result.rejected).toEqual([])
  })

  /** A model retypes a quote with its own line breaks; that is not a fabrication. Runs of
   *  whitespace collapse on both sides before the comparison -- but nothing else does. */
  it('matches across reflowed whitespace, and stays case-sensitive', () => {
    const reflowed = verifySources([source({ quote: 'PostgreSQL\n   on    port\t5433' })], QUESTION, WORLD)
    expect(reflowed.rejected).toEqual([])

    const recased = verifySources([source({ quote: 'postgresql on port 5433' })], QUESTION, WORLD)
    expect(recased.verified).toEqual([])
    expect(recased.rejected[0]?.reason).toBe('quote_not_found')
  })

  it('spans the newline between the task title and its description', () => {
    const result = verifySources([source({ quote: 'Wire the reader Connect to PostgreSQL' })], QUESTION, WORLD)
    expect(result.rejected).toEqual([])
  })

  it('ignores the ref of everything but a message (erratum E1)', () => {
    const result = verifySources(
      [source({ ref: 'a-task-id-the-model-invented', quote: 'Wire the reader' })],
      QUESTION,
      WORLD,
    )
    expect(result.rejected).toEqual([])
  })
})

describe('verifySources -- what is rejected, and why', () => {
  it('rejects a quote that appears in no version of the named source', () => {
    const bad = source({ quote: 'this sentence appears nowhere' })
    const result = verifySources([bad], QUESTION, WORLD)
    expect(result.verified).toEqual([])
    expect(result.rejected).toEqual([{ source: bad, reason: 'quote_not_found' }])
  })

  it('rejects a quote attributed to the wrong source even when the words exist elsewhere', () => {
    const misattributed = source({ kind: 'goal', quote: 'PostgreSQL on port 5433' })
    expect(verifySources([misattributed], QUESTION, WORLD).rejected[0]?.reason).toBe('quote_not_found')
  })

  it('rejects a message ref that is not in the thread', () => {
    const invented = source({ kind: 'message', ref: 'm99', quote: 'answers on 6000' })
    expect(verifySources([invented], QUESTION, WORLD).rejected).toEqual([{ source: invented, reason: 'unknown_ref' }])
  })

  it('rejects a message source with no ref at all', () => {
    const refless = source({ kind: 'message', ref: null, quote: 'answers on 6000' })
    expect(verifySources([refless], QUESTION, WORLD).rejected[0]?.reason).toBe('unknown_ref')
  })

  it('rejects run_context when the asker run recorded no prompt', () => {
    const cited = source({ kind: 'run_context', quote: 'anything' })
    const noPrompt = question({ askerRunPrompt: null })
    expect(verifySources([cited], noPrompt, WORLD).rejected).toEqual([{ source: cited, reason: 'no_such_source' }])
  })

  it('rejects goal when the workspace has none, and task when the question has none', () => {
    expect(verifySources([source({ kind: 'goal', quote: 'x' })], QUESTION, world()).rejected[0]?.reason).toBe(
      'no_such_source',
    )
    const taskless = question({ taskId: null, taskTitle: null, taskDescription: null })
    expect(verifySources([source({ quote: 'x' })], taskless, WORLD).rejected[0]?.reason).toBe('no_such_source')
  })

  it('rejects a quote that is only whitespace rather than letting it match everything', () => {
    expect(verifySources([source({ quote: '   ' })], QUESTION, WORLD).rejected[0]?.reason).toBe('quote_not_found')
  })

  it('keeps the good and the bad apart, in the order they were given', () => {
    const good = source({ quote: 'Wire the reader' })
    const bad = source({ kind: 'goal', quote: 'nowhere at all' })
    const result = verifySources([good, bad], QUESTION, WORLD)
    expect(result.verified).toEqual([good])
    expect(result.rejected).toEqual([{ source: bad, reason: 'quote_not_found' }])
  })
})

describe('isSourced', () => {
  const good = source({ quote: 'Wire the reader' })
  const bad = source({ quote: 'nowhere at all' })

  it.each([
    ['one verified, none rejected', [good], true],
    ['one verified and one rejected', [good, bad], false],
    ['none verified, one rejected', [bad], false],
    ['nothing cited at all', [], false],
  ])('%s -> %s', (_case, sources, expected) => {
    expect(isSourced(verifySources(sources as Source[], QUESTION, WORLD))).toBe(expected)
  })
})
