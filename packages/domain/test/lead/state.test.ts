import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_PROGRESS, leadStateOf, readLeadProgress, type LeadStateFacts } from '../../src/lead/index.js'

const facts = (over: Partial<LeadStateFacts>): LeadStateFacts => ({ status: 'integrating', merged: false, integrated: false, autoMerge: true, mergeFailed: false, ...over })

describe('leadStateOf (lead-flow spec section 3)', () => {
  it('reads building until the lead\'s work is on the branch, then proving', () => {
    expect(leadStateOf(facts({}))).toBe('building')
    expect(leadStateOf(facts({ integrated: true }))).toBe('proving')
    expect(leadStateOf(facts({ status: 'verifying', integrated: true }))).toBe('proving')
  })

  it('reads delivered once merged, whatever the status', () => {
    expect(leadStateOf(facts({ status: 'accepted', merged: true }))).toBe('delivered')
  })

  it('reads awaiting_decision for a stop, and for an accepted version a person must merge', () => {
    expect(leadStateOf(facts({ status: 'needs_human' }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted', autoMerge: false }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted', mergeFailed: true }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted' }))).toBe('proving')
  })

  it('reads stopped for an abandoned version, merged or not', () => {
    expect(leadStateOf(facts({ status: 'abandoned', merged: true }))).toBe('stopped')
  })
})

describe('readLeadProgress', () => {
  it('reads a null column and a broken value as the initial progress', () => {
    expect(readLeadProgress(null)).toEqual(INITIAL_LEAD_PROGRESS)
    expect(readLeadProgress({ recheckKeys: 'R1' })).toEqual(INITIAL_LEAD_PROGRESS)
  })

  it('fills the fields a stored row lacks', () => {
    expect(readLeadProgress({ failing: ['R2'], wrapUpSent: true })).toEqual({ ...INITIAL_LEAD_PROGRESS, failing: ['R2'], wrapUpSent: true })
  })
})
