import { parseRunCostEstimate, type RunCostEstimate } from '@slave-of-ai/domain'

/**
 * Reading `SlaveRun.costEstimate` for the screens (live cost estimate).
 *
 * THE RULE (`packages/domain/src/guardrails/pricing.ts`): an estimate is never added into a
 * reported figure. Everything here returns it BESIDE one, under a name that says `estimated`, and
 * nothing in `./spend.ts` or `./lead/spend.ts` -- what budgets and limits read -- imports this file.
 */

/** The estimate a run's row holds; null when the row holds none. */
export function estimateOfRun(run: { readonly costEstimate: unknown }): RunCostEstimate | null {
  return parseRunCostEstimate(run.costEstimate)
}

const round = (usd: number): number => Math.round(usd * 1e6) / 1e6

/** Whether an estimate has a figure to show: at least one message of a model with a price. */
const priced = (estimate: RunCostEstimate): boolean => estimate.messages > estimate.unpricedMessages

/**
 * The sum of some runs' estimates, or null when none of them has a figure -- no estimate yet, or
 * only messages of a model with no price. Never 0 for "nothing known": a zero is believed.
 */
export function estimatedUsdOf(estimates: readonly (RunCostEstimate | null)[]): number | null {
  const known = estimates.filter((estimate): estimate is RunCostEstimate => estimate !== null && priced(estimate))
  return known.length === 0 ? null : round(known.reduce((total, estimate) => total + estimate.usd, 0))
}

/** The models these estimates could not price, by the name the runtime gave, each once. */
export function unpricedModelsOf(estimates: readonly (RunCostEstimate | null)[]): readonly string[] {
  return [...new Set(estimates.flatMap((estimate) => estimate?.unpriced ?? []))].sort()
}

/** A run that has not reported a cost yet: still open, no figure. Its estimate is the "running" part. */
export const awaitsCost = (run: { readonly costUsd: number | null; readonly endedAt: Date | null }): boolean => run.endedAt === null && run.costUsd === null

export { round as roundUsd }
