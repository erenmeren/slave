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
  /** How many of the runs carried no cost figure at all. */
  readonly unknownRuns: number
}

/**
 * Known spend and how many runs could not be measured. Never folds `null` into the total
 * (spec Decision 6; M12 Task 9, controller ruling R3).
 *
 * There are two different defects that both wore `?? 0`, and the nine markers this task removes
 * did not distinguish them:
 *
 * - On a SINGLE run's cost, `?? 0` is always a lie -- it says an unmeasured run cost nothing.
 *   Those sites became `number | null` end to end and render `—`.
 * - On a SUM, `?? 0` is right for "there were no rows at all" and wrong for "there were rows whose
 *   cost is unknown". Postgres (and so Prisma's `_sum`) already excludes NULLs from an aggregate,
 *   so `known` is not a new number -- it is the number that was already being computed. What is
 *   new is that the count of unmeasured runs stops being invisible: a workspace that has spent
 *   nothing and a workspace whose every run went unmeasured used to be indistinguishable, and
 *   they are the opposite situations.
 *
 * `unknownRuns` is carried to the SURFACES, not to the guardrail -- see `evaluate.ts` for why an
 * "unmeasured runs" breach would fire on every healthy tick.
 */
export function sumSpend(runs: readonly { readonly costUsd: number | null }[]): Spend {
  let known = 0
  let unknownRuns = 0
  for (const run of runs) {
    // `=== null`, not a falsy check: a genuine `costUsd: 0` is a MEASURED zero (a run that really
    // did cost nothing), and counting it as unmeasured would manufacture a hole that is not there.
    if (run.costUsd === null) unknownRuns += 1
    else known += run.costUsd
  }
  return { known, unknownRuns }
}
