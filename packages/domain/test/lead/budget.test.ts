import { describe, expect, it } from 'vitest'
import { cents, isBudgetCapReason, leadShareUsd, nextLeadLeg, proofCapUsd } from '../../src/lead/index.js'

describe('the lead\'s budget legs (lead-flow spec B4)', () => {
  it('reserves one fifth of the budget for proof', () => {
    expect(leadShareUsd(30)).toBe(24)
  })

  it('caps the first leg at four fifths of the share, less what earlier turns spent', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 0, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 19.2, wrapUp: false })
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 5.5, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 13.7, wrapUp: false })
  })

  it('makes the next leg the wrap-up once the mark is reached, capped at the rest of the share', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 19.2, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 4.8, wrapUp: true })
  })

  it('gives a later turn what is left of the share without a second wrap-up', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 20, wrapUpSent: true })).toEqual({ kind: 'run', capUsd: 4, wrapUp: false })
  })

  it('says spent when less than a spawn is worth is left, and never caps an unbudgeted goal', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 23.97, wrapUpSent: true })).toEqual({ kind: 'spent' })
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 40, wrapUpSent: false })).toEqual({ kind: 'spent' })
    expect(nextLeadLeg({ budgetUsd: null, leadSpentUsd: 99, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: null, wrapUp: false })
  })

  it('never lets a leg eat the proof reserve once proof runs spent into the share (spec P5)', () => {
    // $30: $6 is the reserve. The lead spent $10 and proof $3, so $11 is all a leg may take.
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 10, wrapUpSent: true, proofSpentUsd: 3 })).toEqual({ kind: 'run', capUsd: 11, wrapUp: false })
    // Before the wrap-up mark the reserve can bind too: $14.20 to the mark, $7 above the reserve.
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 5, wrapUpSent: false, proofSpentUsd: 12 })).toEqual({ kind: 'run', capUsd: 7, wrapUp: false })
    // Down to cents, downwards.
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 10, wrapUpSent: true, proofSpentUsd: 3.333 })).toEqual({ kind: 'run', capUsd: 10.66, wrapUp: false })
    // $4 left of the share, but proof spent the rest down to the reserve: nothing for the lead.
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 20, wrapUpSent: true, proofSpentUsd: 4 })).toEqual({ kind: 'spent' })
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 20, wrapUpSent: true, proofSpentUsd: 3.97 })).toEqual({ kind: 'spent' })
    // No proof spend yet: the legs are the share's alone, the first wrap-up exactly $4.80.
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 19.2, wrapUpSent: false, proofSpentUsd: 0 })).toEqual({ kind: 'run', capUsd: 4.8, wrapUp: true })
    expect(nextLeadLeg({ budgetUsd: null, leadSpentUsd: 99, wrapUpSent: true, proofSpentUsd: 50 })).toEqual({ kind: 'run', capUsd: null, wrapUp: false })
  })

  it('cuts dollars to whole cents downwards', () => {
    expect(cents(23.996)).toBe(23.99)
    expect(cents(4.8)).toBe(4.8)
    expect(cents(0.1 + 0.2)).toBe(0.3)
  })

  it('caps a proof run at whatever the goal has left, reserve included', () => {
    expect(proofCapUsd(30, 24)).toBe(6)
    expect(proofCapUsd(30, 29.99)).toBe('spent')
    expect(proofCapUsd(null, 500)).toBeNull()
  })

  it('reads a budget cap out of a run\'s terminal reason', () => {
    expect(isBudgetCapReason('budget_exhausted')).toBe(true)
    expect(isBudgetCapReason('error_max_budget_usd.')).toBe(true)
    expect(isBudgetCapReason('error_during_execution.')).toBe(false)
  })
})
