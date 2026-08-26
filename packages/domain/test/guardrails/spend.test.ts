import { describe, expect, it } from 'vitest'
import { sumSpend } from '../../src/guardrails/spend.js'

/**
 * Spec Decision 6 in its aggregate form (M12 Task 9, controller ruling R3). `?? 0` on a single
 * run's cost and `?? 0` on a SUM of costs are two different defects wearing the same syntax: the
 * second one is right for "there were no rows at all" and wrong for "there were rows whose cost is
 * unknown", and the old code could not tell them apart because it collapsed both into a number.
 */
describe('sumSpend', () => {
  it('never counts an unknown cost as zero when summing spend', () => {
    expect(sumSpend([{ costUsd: 1.5 }, { costUsd: null }])).toEqual({ known: 1.5, unknownRuns: 1 })
  })

  it('reports zero known spend and zero unknown runs for no rows at all', () => {
    // The one case the old `?? 0` got right, and it must stay right: nothing ran, so nothing was
    // spent -- that is a measured zero, not an unmeasured one.
    expect(sumSpend([])).toEqual({ known: 0, unknownRuns: 0 })
  })

  it('distinguishes "nothing ran" from "everything that ran was unmeasured"', () => {
    // Both used to read as `0`. They are the difference between a workspace that has spent
    // nothing and a workspace whose spend nobody can account for.
    expect(sumSpend([])).toEqual({ known: 0, unknownRuns: 0 })
    expect(sumSpend([{ costUsd: null }, { costUsd: null }])).toEqual({ known: 0, unknownRuns: 2 })
  })

  it('counts a genuine zero-cost run as known, not as unmeasured', () => {
    expect(sumSpend([{ costUsd: 0 }, { costUsd: 0.25 }])).toEqual({ known: 0.25, unknownRuns: 0 })
  })

  it('sums every known row while counting every unknown one', () => {
    expect(sumSpend([{ costUsd: 1 }, { costUsd: null }, { costUsd: 2.5 }, { costUsd: null }])).toEqual({
      known: 3.5,
      unknownRuns: 2,
    })
  })
})
