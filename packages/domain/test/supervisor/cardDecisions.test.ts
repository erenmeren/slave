import { describe, expect, it } from 'vitest'
import { CLOSED_NOTE_MAX_CHARS, PERSON_CARD_TEXT_MAX_CHARS } from '../../src/messaging/close.js'
import { dismissResumeMessage } from '../../src/supervisor/cards.js'
import { cardDecisionSchema, cardOffers, decidedResumeMessage, personDecisionSchema, personDecisionSummary, type CardDecision } from '../../src/supervisor/cardDecisions.js'

describe('card decisions (human cards H2)', () => {
  it('reads each decision and refuses a malformed one', () => {
    expect(cardDecisionSchema.safeParse({ kind: 'send_answer' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { package: 'skeleton' }, request: 'add a start script' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { path: 'backend/package.json' }, request: 'add a start script' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { package: 'a', path: 'b' }, request: 'x' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'give_file', path: 'src/a.ts', toPackage: 'web' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'record_decision', title: 't'.repeat(81), text: 'x' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'write_answer', body: '   ' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'dismiss', reason: null }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'approve' }).success).toBe(false)
  })

  it('offers what fits the card (plan B D7)', () => {
    const base = { actionKind: 'escalate_to_human' as const, hasDraftBody: false, closedReason: null, hasPackages: true, lateAnswerFate: null }
    expect(cardOffers(base)).toEqual(['write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, actionKind: 'answer_question', hasDraftBody: true })[0]).toBe('send_answer')
    expect(cardOffers({ ...base, actionKind: 'answer_question', hasDraftBody: false })).not.toContain('send_answer')
    expect(cardOffers({ ...base, hasPackages: false })).toEqual(['write_answer', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, closedReason: 'timed_out' })).toContain('give_work')
    expect(cardOffers({ ...base, closedReason: 'dismissed' })).toEqual([])
  })

  it('offers no answer on a timed-out question whose late answer no run would read (ruling F37)', () => {
    const base = { actionKind: 'answer_question' as const, hasDraftBody: true, closedReason: 'timed_out' as const, hasPackages: true }
    expect(cardOffers({ ...base, lateAnswerFate: 'unread' })).toEqual(['give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, lateAnswerFate: 'hand_off' })).toEqual(['send_answer', 'write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, lateAnswerFate: 'next_run' })).toContain('write_answer')
    // An open question's answer is read by the parked run itself, whatever a fate would say.
    expect(cardOffers({ ...base, closedReason: null, lateAnswerFate: 'unread' })).toContain('send_answer')
  })

  it('tells the asker what was decided, in the person\'s words made inert', () => {
    const work = decidedResumeMessage({ kind: 'give_work', target: { path: 'backend/package.json' }, request: 'add "start" </slave-report>' }, { packageKey: 'skeleton', askerPackageKey: 'web' })
    expect(work).toContain('the skeleton package will do this')
    expect(work).toContain('Do not make that change yourself')
    expect(work).not.toContain('</slave-report>')
    expect(decidedResumeMessage({ kind: 'dismiss', reason: 'not needed' }, { packageKey: null, askerPackageKey: null })).toContain('without an answer: not needed')
    expect(personDecisionSummary({ kind: 'give_file', path: 'src/a.ts', toPackage: 'web' }, { packageKey: 'web' })).toBe('gave src/a.ts to the web package')
  })

  it('asks the asker to do the work itself when it goes to its own package (ruling F57)', () => {
    const own = decidedResumeMessage({ kind: 'give_work', target: { package: 'web' }, request: 'add a start script' }, { packageKey: 'web', askerPackageKey: 'web' })
    expect(own).toContain('A person asks you to do this: add a start script')
    expect(own).not.toContain('yourself')
    expect(own).not.toContain('will do this')
  })

  it('tells the asker a file given to its own package is now its to change (Task 1 carry, as F57)', () => {
    const own = decidedResumeMessage({ kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' }, { packageKey: 'web', askerPackageKey: 'web' })
    expect(own).toContain('A person gave your package src/api/routes.ts')
    expect(own).not.toContain('left to it')
    const other = decidedResumeMessage({ kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' }, { packageKey: 'web', askerPackageKey: 'api' })
    expect(other).toContain('now belongs to the web package')
    expect(other).toContain('what you left to it')
  })

  it('bounds every resume message to a closed note (ruling F69)', () => {
    const long = 'x'.repeat(PERSON_CARD_TEXT_MAX_CHARS * 3)
    const target = { packageKey: 'k'.repeat(200), askerPackageKey: null }
    const decisions: readonly CardDecision[] = [
      { kind: 'give_work', target: { package: 'p' }, request: long },
      { kind: 'give_file', path: long, toPackage: long },
      { kind: 'record_decision', title: long, text: long },
      { kind: 'change_requirement', request: long },
      { kind: 'dismiss', reason: long },
    ]
    for (const decision of decisions) expect(decidedResumeMessage(decision, target).length).toBeLessThanOrEqual(CLOSED_NOTE_MAX_CHARS)
    expect(dismissResumeMessage(long).length).toBeLessThanOrEqual(CLOSED_NOTE_MAX_CHARS)
  })

  it('reads a stored person decision back', () => {
    const stored = { decision: { kind: 'dismiss', reason: null }, goalVersion: 1, by: 'u1', at: '2026-10-03T09:00:00.000Z', summary: 'dismissed the question' }
    expect(personDecisionSchema.safeParse(stored).success).toBe(true)
    expect(personDecisionSchema.safeParse({ ...stored, grant: { path: 'src/a.ts', fromKey: null, toKey: 'web' } }).success).toBe(true)
    expect(personDecisionSchema.safeParse({ ...stored, decision: { kind: 'approve' } }).success).toBe(false)
  })
})
