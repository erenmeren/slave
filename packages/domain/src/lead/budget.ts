import { LEAD_MIN_LEG_USD, LEAD_WRAP_UP_RATIO, PROOF_RESERVE_RATIO } from './constants.js'

/** Dollars cut to whole cents, downwards: a cap is never rounded up past what is left. */
const cents = (usd: number): number => Math.floor(usd * 100 + 1e-6) / 100

/** Lead-flow spec B4: the lead's share of a goal's budget -- all but the fifth kept for proof. */
export function leadShareUsd(budgetUsd: number): number {
  return cents(budgetUsd * (1 - PROOF_RESERVE_RATIO))
}

/** What the lead's next turn may spend: a run with a cap (null: unbudgeted), or nothing left. */
export type LeadLeg = { readonly kind: 'run'; readonly capUsd: number | null; readonly wrapUp: boolean } | { readonly kind: 'spent' }

/**
 * Lead-flow spec B4 (plan A L6): the lead's next leg. Until the wrap-up was sent, a leg runs to four
 * fifths of the share; the leg after that mark is the wrap-up, capped at the rest of the share. A
 * turn after the wrap-up (a rework) gets what is left. Less than `LEAD_MIN_LEG_USD` left is `spent`.
 */
export function nextLeadLeg(input: { readonly budgetUsd: number | null; readonly leadSpentUsd: number; readonly wrapUpSent: boolean }): LeadLeg {
  if (input.budgetUsd === null) return { kind: 'run', capUsd: null, wrapUp: false }
  const share = leadShareUsd(input.budgetUsd)
  const left = cents(share - input.leadSpentUsd)
  if (left < LEAD_MIN_LEG_USD) return { kind: 'spent' }
  const toMark = cents(share * LEAD_WRAP_UP_RATIO - input.leadSpentUsd)
  if (!input.wrapUpSent && toMark >= LEAD_MIN_LEG_USD) return { kind: 'run', capUsd: toMark, wrapUp: false }
  return { kind: 'run', capUsd: left, wrapUp: !input.wrapUpSent }
}

/** Spec B4/§9: what a proof run may spend -- everything the goal has left, the reserve included. */
export function proofCapUsd(budgetUsd: number | null, goalSpentUsd: number): number | null | 'spent' {
  if (budgetUsd === null) return null
  const left = cents(budgetUsd - goalSpentUsd)
  return left < LEAD_MIN_LEG_USD ? 'spent' : left
}

/**
 * Whether a run's terminal reason is the vendor's budget cap. Measured 2026-10-04 (C3): the result
 * line reads `terminal_reason: "budget_exhausted"`; `max_budget` is the subtype's spelling, kept for
 * a line that names only that.
 */
export function isBudgetCapReason(reason: string): boolean {
  return /budget_exhausted|max_budget/i.test(reason)
}
