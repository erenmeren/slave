/**
 * REAL money, formatted once (M51 R5).
 *
 * The sibling of `./money.ts`, whose `formatMinor` is for SIMULATED money and whose own first line
 * says "real model spend is a separate figure". That note has been true and unenforced since M29:
 * every real-money surface in this app did `.toFixed(2)` inline, which is a dozen copies of one
 * decision and a dozen chances to render a null as `$NaN` or an unmeasured run as `$0.00`.
 *
 * `null` is `—` and never `$0.00`, which is the whole point: a zero is a figure a reader believes,
 * and `SlaveRun.costUsd` was made nullable precisely so "we did not measure this" could be said
 * (`packages/db/prisma/schema.prisma`'s own column comment). `<$0.01` rather than `$0.00` for a real
 * figure that rounds away, for the same reason in the other direction: money that was spent must
 * not print as money that was not.
 *
 * A non-finite figure reads as `—` for the same reason a null does -- `$NaN` on a money surface
 * looks like a fault in the bill rather than a gap in the measurement.
 *
 * SIMULATED money never comes here (decision D21): `lib/money.ts` and `components/sim/` keep the
 * boundary M29 drew, and this milestone does not move it.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}
