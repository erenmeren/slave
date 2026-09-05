import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '../run/state.js'

/**
 * What a set of runs is known to have cost, and how many of them nobody can account for.
 *
 * The two numbers are deliberately not collapsible into one. `known` is money that was actually
 * measured; `unknownRuns` is the size of the hole in that measurement. A single figure cannot say
 * both, which is precisely how `?? 0` used to hide the second one.
 */
export interface Spend {
  /** USD actually reported, summed. Never includes a guess for a run that reported nothing. */
  readonly known: number
  /**
   * How many runs actually engaged a runtime, concluded, and left no cost figure behind. NOT the
   * count of null `costUsd` columns -- see `sumSpend` for why those are different questions.
   */
  readonly unknownRuns: number
}

/**
 * The three `SlaveRun` columns it takes to tell an unmeasured run from a null cost. All three are
 * load-bearing; see `sumSpend`.
 */
export interface SpendRow {
  readonly costUsd: number | null
  /**
   * `SlaveRun.provider`, typed as a bare string because only its NULLNESS is read here and
   * `ProviderKind` lives in `@slave-of-ai/providers`, which depends on this package rather than the
   * other way round.
   */
  readonly provider: string | null
  readonly status: RunStatus
}

/**
 * Known spend and how many runs could not be measured. Never folds `null` into the total
 * (spec Decision 6; M12 Task 9, controller ruling R3).
 *
 * ## Why `known` and `unknownRuns` are computed over different sets
 *
 * `known` sums every row's reported cost, unconditionally. Postgres' `sum()` does the same thing
 * (it skips NULLs), so this half is not new behaviour -- it is the number the `_sum` aggregates
 * were already producing, restated where the other half can be produced beside it.
 *
 * `unknownRuns` is NOT "how many rows have `costUsd IS NULL`". That was this function's first
 * shipped meaning and it was wrong (fix round F1): it made a healthy workspace with three slaves
 * working read "3 unmeasured", and it made every refused dispatch add one to a figure that could
 * never come back down. `costUsd` is null in four situations and only one of them is an unmeasured
 * run. The column facts, verified against the tree rather than assumed:
 *
 * - `pump.ts`'s terminal `updateMany` is the ONLY writer of `SlaveRun.costUsd` anywhere in the
 *   codebase, and it writes it in the same statement as `status: succeeded|failed`, `terminalAt`
 *   and `endedAt`. So a run in flight ALWAYS has a null cost, no matter how well it is going.
 * - `SlaveRun.provider` is written in the same statement as `pid` -- `tick.ts`, `planning.ts` and
 *   `review.ts` each do one `slaveRun.update` STRICTLY AFTER `await adapter.start(...)` has
 *   returned a handle. There is no path that writes `provider` without a live process behind it,
 *   which is what makes it an exact discriminator for "a runtime actually ran this" -- with one
 *   hole, named here rather than left in a task report: if `adapter.start()` succeeds and the
 *   `slaveRun.update` on the next line throws, a live process exists behind a null `provider`
 *   and that run is UNDER-counted here. No better discriminator exists without a schema change
 *   (`pid` and `worktreePath` are written by that same statement; `sessionId` shares the window
 *   AND misses a runtime that dies before init), and in that window `failToStart`'s own writes
 *   are likely failing too. Under-counting is also the safer direction: it understates a hole
 *   rather than inventing one.
 * - `tick.ts`'s `failToStart` writes `status`/`terminalAt`/`endedAt` and NEITHER of the above. So
 *   a refusal (`unmeasurable_budget`, `invalid_provider`), a worktree failure, or an adapter that
 *   threw before spawning leaves a terminal row with a null cost that spent exactly nothing.
 *
 * Hence: **a run counts as unmeasured when it spawned (`provider` written), it is finished (a
 * terminal status), and no cost was recorded.** A run in flight is unfinished, not unmeasured. A
 * run that never spawned spent nothing. A run that spawned and was killed -- stopped by an
 * operator, swept, or concluded by a runtime that reports no figure -- IS unmeasured: it spent
 * real money nobody can name, and that is the case this field exists for.
 *
 * The qualification is applied to the COUNT and not as a filter over the rows, deliberately. A row
 * written before M12 has a real recorded cost and a null `provider` (the column did not exist),
 * because the migration dropped `costUsd`'s NOT NULL without a backfill. Filtering such rows out
 * of the input would silently remove their money from `known` -- changing the spend figure itself
 * in order to fix the count beside it.
 */
export function sumSpend(runs: readonly SpendRow[]): Spend {
  let known = 0
  let unknownRuns = 0
  for (const run of runs) {
    // `=== null`, not a falsy check: a genuine `costUsd: 0` is a MEASURED zero (a run that really
    // did cost nothing), and counting it as unmeasured would manufacture a hole that is not there.
    if (run.costUsd !== null) {
      known += run.costUsd
      continue
    }
    if (run.provider !== null && !isInFlight(run.status)) unknownRuns += 1
  }
  return { known, unknownRuns }
}

function isInFlight(status: RunStatus): boolean {
  return (NON_TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status)
}

/** One (provider, status) bucket of runs, pre-aggregated by the database. `knownUsd` is the
 *  bucket's summed non-null costs (Postgres `sum()` skips NULLs — the same arithmetic as
 *  `sumSpend`'s `known`); `measuredCount` is how many rows had a non-null cost. */
export interface SpendGroup {
  readonly provider: string | null
  readonly status: RunStatus
  readonly knownUsd: number
  readonly rowCount: number
  readonly measuredCount: number
}

/**
 * `sumSpend` over rows the database has already grouped. The RULE lives in `sumSpend`'s doc
 * comment above and does not repeat here: known sums unconditionally; a row is unmeasured when
 * it spawned (`provider` written), finished (terminal status), and reported nothing. Groups
 * only make the arithmetic wholesale: the unmeasured rows of a qualifying bucket are exactly
 * `rowCount - measuredCount`. Equivalence is pinned by `test/spend-groups.test.ts`.
 */
export function sumSpendFromGroups(groups: readonly SpendGroup[]): Spend {
  let known = 0
  let unknownRuns = 0
  for (const group of groups) {
    known += group.knownUsd
    if (group.provider !== null && !isInFlight(group.status)) unknownRuns += group.rowCount - group.measuredCount
  }
  return { known, unknownRuns }
}
