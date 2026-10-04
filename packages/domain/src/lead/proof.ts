import type { StopReason } from './constants.js'
import type { LeadProgress } from './progress.js'

/** One requirement's verdict, as the loop reads it. */
export interface ProofItem {
  readonly key: string
  readonly status: 'pass' | 'fail' | 'unverifiable'
}

/** What happens after a concluded round or check. `progress` is what to store with the move. */
export type ProofStep =
  | { readonly kind: 'accept'; readonly progress: LeadProgress }
  | { readonly kind: 'confirm'; readonly progress: LeadProgress }
  | { readonly kind: 'verify_again'; readonly progress: LeadProgress }
  | { readonly kind: 'rework'; readonly progress: LeadProgress; readonly keys: readonly string[] }
  | { readonly kind: 'stop'; readonly progress: LeadProgress; readonly reason: StopReason }

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])]

/**
 * Lead-flow spec P3-P5/P7 (plan A L11/L12): what a concluded verification round means. `scope` is
 * `partial` for a round that checked only what failed before.
 *
 * - What this round says about a key replaces what earlier rounds said: a key it passes is no longer
 *   disputed or unverifiable; one it cannot verify is.
 * - A failure goes to the confirmer first (P3). A key already disputed is not confirmed again: it
 *   stays disputed.
 * - No failure: a partial round, or a full one whose tip moved under it, is followed by the full
 *   verification (P5). A full round on the current tip accepts, unless something is disputed or
 *   unverifiable -- then nothing is left to rework and not everything is proven (P4, spec D2).
 * - With the lead ended, a failure cannot be reworked: the version stops with the lead's reason (P7).
 */
export function afterRound(input: {
  readonly scope: 'full' | 'partial'
  readonly items: readonly ProofItem[]
  readonly progress: LeadProgress
  readonly runId: string
  readonly tipMoved: boolean
}): ProofStep {
  const { items, progress } = input
  const checked = new Set(items.map((one) => one.key))
  const passed = items.filter((one) => one.status === 'pass').map((one) => one.key)
  const unverifiable = union(progress.unverifiable.filter((key) => !checked.has(key)), items.filter((one) => one.status === 'unverifiable').map((one) => one.key))
  const disputed = progress.disputed.filter((key) => !passed.includes(key))
  const failed = items.filter((one) => one.status === 'fail' && !disputed.includes(one.key)).map((one) => one.key)
  const base: LeadProgress = { ...progress, unverifiable, disputed, confirm: null }

  if (failed.length > 0) {
    if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...base, failing: failed } }
    return { kind: 'confirm', progress: { ...base, confirm: { runId: input.runId, keys: failed, scope: input.scope } } }
  }
  const settled: LeadProgress = { ...base, failing: [], recheckKeys: [] }
  if (input.scope === 'partial' || input.tipMoved) return { kind: 'verify_again', progress: settled }
  if (unverifiable.length > 0 || disputed.length > 0) return { kind: 'stop', reason: 'not_all_proven', progress: settled }
  return { kind: 'accept', progress: settled }
}

/**
 * Lead-flow spec P3/P7: what the confirmer's re-check means. A key both failed is confirmed; any
 * other is disputed and never reworked. Nothing confirmed: after a partial round the full
 * verification follows; after a full one nothing is left to rework. A confirmed set equal to the
 * previous round's is two rounds in a row with no progress. Otherwise the confirmed keys go back to
 * the lead, and the next round checks exactly them (P5).
 */
export function afterConfirm(input: { readonly items: readonly ProofItem[]; readonly progress: LeadProgress }): ProofStep {
  const { progress } = input
  const pending = progress.confirm
  // A replay: nothing was awaiting confirmation. The next pass verifies what the progress says.
  if (pending === null) return { kind: 'verify_again', progress }
  const statusOf = new Map(input.items.map((one) => [one.key, one.status] as const))
  const confirmed = pending.keys.filter((key) => statusOf.get(key) === 'fail')
  const disputed = union(progress.disputed, pending.keys.filter((key) => !confirmed.includes(key)))
  const base: LeadProgress = { ...progress, confirm: null, disputed }

  if (confirmed.length === 0) {
    const settled: LeadProgress = { ...base, failing: [], recheckKeys: [] }
    return pending.scope === 'partial' ? { kind: 'verify_again', progress: settled } : { kind: 'stop', reason: 'not_all_proven', progress: settled }
  }
  if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...base, failing: confirmed } }
  if (sameSet(confirmed, progress.failing)) return { kind: 'stop', reason: 'no_progress', progress: { ...base, failing: confirmed } }
  return { kind: 'rework', keys: confirmed, progress: { ...base, failing: confirmed, recheckKeys: confirmed } }
}

/**
 * Lead-flow spec P2/P7: a check that is not a requirement verdict failed (the smoke script, `key` =
 * `SMOKE`). It goes back to the lead as the failing set `[key]` -- the same set twice in a row
 * stops the version, as does an ended lead.
 */
export function afterCheckFailure(progress: LeadProgress, key: string): ProofStep {
  const failing = [key]
  if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...progress, failing } }
  if (sameSet(failing, progress.failing)) return { kind: 'stop', reason: 'no_progress', progress }
  return { kind: 'rework', keys: failing, progress: { ...progress, failing } }
}
