/**
 * One sector metric as a figure to print, or `null` when there is no figure to print.
 *
 * A sector's metrics are `unknown`-valued (M32 item 6): a plugin publishes whatever shape it
 * likes, and trade's carries a `sources` object of provenance lists and a `minCashDay` companion
 * beside its numbers. `metricLabels` names the keys that are meant to be numbers; this is what a
 * page does when one of them turns out not to be.
 *
 * The rule is control's `metricDeltas` rule, exactly: a missing key is 0, and anything that is not
 * a FINITE number has no figure at all. Shared by the run page's metric panel and the compare
 * page's table (M32 review) so a figure and its delta can never disagree about what is a number --
 * a run page that printed `0` beside a compare page that printed `—` for the same metric would be
 * two answers to one question.
 */
export function metricValue(value: unknown): number | null {
  if (value === undefined) return 0
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
