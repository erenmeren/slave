/**
 * H9b R1: the Prisma `where` fragment for "a run that is not a platform failure" -- `failureClass`
 * is `worker`, or there is none (a run that did not fail, or a failure written before the column
 * existed, which counts as the worker's). Spread into a count's `where`: beside `status: 'failed'`
 * it is "the failures the worker is charged for", and alone it is "the attempts that were really
 * made" (`dispatchReview`'s retry cap).
 *
 * Spelt as an `OR` with `null` on purpose, and shared so nobody spells it again: the obvious
 * `failureClass: { not: 'platform' }` compiles to `"failureClass" <> 'platform'`, which is NULL --
 * not true -- for every unclassified row, so it silently stops counting every failure older than
 * the column. The raw-SQL readers (`workspaceStats`) say `IS DISTINCT FROM` for the same reason.
 */
export const NOT_PLATFORM_FAILURE = {
  OR: [{ failureClass: null }, { failureClass: 'worker' as const }],
}
