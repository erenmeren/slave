import { describe, expect, it } from 'vitest'
import { sumSpend, type SpendRow } from '../../src/guardrails/spend.js'

/**
 * A run that a runtime actually ran and concluded: `provider` is written in the same statement as
 * `pid`, only after the spawn returns, and a terminal status means the pump (or a kill) has had
 * its say. Every fixture below states its three columns explicitly, because which combination is
 * being described IS the thing under test.
 */
const ran = (costUsd: number | null): SpendRow => ({ costUsd, provider: 'claude_code', status: 'succeeded' })

/**
 * Spec Decision 6 in its aggregate form (M12 Task 9, controller ruling R3). `?? 0` on a single
 * run's cost and `?? 0` on a SUM of costs are two different defects wearing the same syntax: the
 * second one is right for "there were no rows at all" and wrong for "there were rows whose cost is
 * unknown", and the old code could not tell them apart because it collapsed both into a number.
 */
describe('sumSpend', () => {
  it('never counts an unknown cost as zero when summing spend', () => {
    expect(sumSpend([ran(1.5), ran(null)])).toEqual({ known: 1.5, unknownRuns: 1 })
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
    expect(sumSpend([ran(null), ran(null)])).toEqual({ known: 0, unknownRuns: 2 })
  })

  it('counts a genuine zero-cost run as known, not as unmeasured', () => {
    expect(sumSpend([ran(0), ran(0.25)])).toEqual({ known: 0.25, unknownRuns: 0 })
  })

  it('sums every known row while counting every unknown one', () => {
    expect(sumSpend([ran(1), ran(null), ran(2.5), ran(null)])).toEqual({
      known: 3.5,
      unknownRuns: 2,
    })
  })

  // --- What "unmeasured" actually means (M12 Task 9, fix round F1) ---
  //
  // `costUsd` is null in four situations and only ONE of them is an unmeasured run. The column
  // facts, re-derived from the tree rather than assumed:
  //   * `pump.ts`'s terminal `updateMany` is the ONLY writer of `AgentRun.costUsd`, and it writes
  //     it in the same statement as `status: succeeded|failed`, `terminalAt` and `endedAt`.
  //   * `AgentRun.provider` is written in the same statement as `pid`, at `tick.ts`,
  //     `planning.ts` and `review.ts`, STRICTLY AFTER `await adapter.start(...)` returns a handle.
  //   * `tick.ts`'s `failToStart` writes `status`/`terminalAt`/`endedAt` and neither of the above.

  it('does not count a run that is merely in flight -- unfinished is not unmeasured', () => {
    // Three agents working would otherwise read "3 unmeasured" on a workspace where nothing is
    // unmeasurable, and the figure would be wrong for as long as the work is going well.
    const live: readonly SpendRow[] = [
      { costUsd: null, provider: 'claude_code', status: 'working' },
      { costUsd: null, provider: 'claude_code', status: 'starting' },
      { costUsd: null, provider: 'claude_code', status: 'paused' },
      { costUsd: null, provider: 'claude_code', status: 'pause_requested' },
      { costUsd: null, provider: 'claude_code', status: 'resuming' },
      { costUsd: null, provider: 'claude_code', status: 'stopping' },
    ]
    expect(sumSpend(live)).toEqual({ known: 0, unknownRuns: 0 })
  })

  it('does not count a run that never spawned -- it spent nothing, and it would never come back down', () => {
    // `provider: null` on a TERMINAL row is exactly `failToStart`'s signature: an
    // `unmeasurable_budget` or `invalid_provider` refusal, a worktree failure, an adapter that
    // threw before the process existed. Counting these made the figure a floor that only grew.
    expect(sumSpend([{ costUsd: null, provider: null, status: 'failed' }])).toEqual({
      known: 0,
      unknownRuns: 0,
    })
  })

  it('DOES count a run that spawned and was killed -- real money nobody can name', () => {
    // The case the field exists for, alongside a runtime that concluded reporting no figure. A
    // process ran; whatever it spent is unrecoverable.
    const killed: readonly SpendRow[] = [
      { costUsd: null, provider: 'claude_code', status: 'stopped' },
      { costUsd: null, provider: 'cursor', status: 'failed' },
      { costUsd: null, provider: 'cursor', status: 'succeeded' },
    ]
    expect(sumSpend(killed)).toEqual({ known: 0, unknownRuns: 3 })
  })

  it('keeps a pre-M12 row in the known total, where its recorded cost belongs', () => {
    // The M12 migration dropped `costUsd`'s NOT NULL without a backfill, so every row written
    // before it kept its figure -- and none of them has a `provider`, because that column did not
    // exist. Its cost is known and must stay in the total, which is why the qualification is
    // applied to the COUNT and not as a filter over the rows.
    expect(sumSpend([{ costUsd: 4.25, provider: null, status: 'succeeded' }])).toEqual({
      known: 4.25,
      unknownRuns: 0,
    })
  })

  it('separates the two halves on a realistic mixed workspace', () => {
    expect(
      sumSpend([
        { costUsd: 1.5, provider: 'claude_code', status: 'succeeded' }, // measured
        { costUsd: null, provider: 'claude_code', status: 'working' }, // in flight
        { costUsd: null, provider: null, status: 'failed' }, // never spawned
        { costUsd: null, provider: 'cursor', status: 'succeeded' }, // genuinely unmeasured
        { costUsd: 2.0, provider: null, status: 'succeeded' }, // legacy row
      ]),
    ).toEqual({ known: 3.5, unknownRuns: 1 })
  })
})
