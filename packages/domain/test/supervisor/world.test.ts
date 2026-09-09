import { describe, expect, it } from 'vitest'
import { THREAD_MESSAGES_MAX } from '../../src/supervisor/constants.js'
import { boundThread } from '../../src/supervisor/world.js'
import { threadMessage } from './fixtures.js'

/**
 * Erratum E9. Nothing bounded a question's thread before this: `loadThreads` read every row of it
 * and `buildAnswerPrompt` printed every one of them, so the size of a Supervisor answer call was
 * whatever two workers had typed at each other since the thread opened.
 */
describe('boundThread', () => {
  /** `n` messages, oldest first, ids `t0`..`t{n-1}` -- the order the loader hands over. */
  const thread = (n: number) =>
    Array.from({ length: n }, (_unused, index) =>
      threadMessage({ messageId: `t${String(index)}`, kind: index === 0 ? 'question' : 'note' }),
    )

  it('leaves a thread shorter than the cap exactly as it is', () => {
    const short = thread(3)
    expect(boundThread(short, 't0')).toBe(short)
    const exact = thread(THREAD_MESSAGES_MAX)
    expect(boundThread(exact, 't0')).toBe(exact)
  })

  it('keeps the newest THREAD_MESSAGES_MAX of a 45-message thread, oldest first', () => {
    const long = thread(45)
    // The question is the newest message here, so nothing has to be rescued into the window.
    const bounded = boundThread(long, 't44')
    expect(bounded).toHaveLength(THREAD_MESSAGES_MAX)
    expect(bounded.map((message) => message.messageId)).toEqual(
      Array.from({ length: THREAD_MESSAGES_MAX }, (_unused, index) => `t${String(45 - THREAD_MESSAGES_MAX + index)}`),
    )
  })

  /**
   * The rescue is not cosmetic: `verifySources` refuses a citation of the question by LOOKING IT UP
   * in the thread, so a window that dropped an old question would quietly re-open the hole erratum
   * E4 closed -- the model could quote the words it was asked and have them verify.
   */
  it('keeps the QUESTION however old it is, in place of the oldest message it displaces', () => {
    const long = thread(45)
    const bounded = boundThread(long, 't0')
    expect(bounded).toHaveLength(THREAD_MESSAGES_MAX)
    expect(bounded[0]?.messageId).toBe('t0')
    // Oldest-first still, and the message the question displaced is the one that went.
    expect(bounded[1]?.messageId).toBe('t6')
    expect(bounded.at(-1)?.messageId).toBe('t44')
  })

  it('stands as a plain window when the thread does not contain its own question', () => {
    const bounded = boundThread(thread(45), 'a-message-in-another-thread')
    expect(bounded).toHaveLength(THREAD_MESSAGES_MAX)
    expect(bounded[0]?.messageId).toBe('t5')
  })
})
