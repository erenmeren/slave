import { formatUsd } from './format'

/**
 * How an ESTIMATE of cost is said (live cost estimate), one way everywhere.
 *
 * The rule the screens keep: an estimate is never shown as a reported figure. It always reads
 * "about", it is never added into a reported sum, and the word "estimate" is in the text or in the
 * `title` beside it. A plain module, so a server page may call it.
 */

/** What an estimate is, for a `title`: where it comes from and why the reported figure differs. */
export const ESTIMATE_TITLE =
  'An estimate from the tokens used so far. The cost is reported when the session ends, and is usually somewhat higher: thinking the model does not show is not counted.'

/** `about $3.20`. */
export function aboutUsd(usd: number): string {
  return `about ${formatUsd(usd)}`
}

/** `no price known for claude-x`: a model with no price has no estimate, and says so instead of a number. */
export function unpricedWord(models: readonly string[]): string {
  return `no price known for ${models.join(', ')}`
}

/**
 * The line under a reported sum while something runs: `+ about $3.20 running (estimate)`, or that
 * the running model has no price; null when nothing running has anything to say.
 */
export function runningEstimateLine(usd: number, unpricedModels: readonly string[]): string | null {
  if (usd > 0) return `+ ${aboutUsd(usd)} running (estimate)`
  return unpricedModels.length > 0 ? `Running: ${unpricedWord(unpricedModels)}` : null
}
