/**
 * The three dispatch limits a person may move on a project (H9 F8), and how far.
 *
 * `Workspace.runTimeoutMs`, `maxConcurrentRuns` and `maxAttempts` had their defaults since M2 and
 * NO writer: the Runtime panel showed them read-only and no CLI verb touched them, so a project
 * whose tasks legitimately take longer than thirty minutes could only be helped by an UPDATE typed
 * into psql (done for one project on 2026-09-21: sixty minutes). `setWorkspaceLimits` is the
 * writer, and these are its bounds.
 *
 * Here rather than in `packages/control` because the Runtime panel is a CLIENT component and must
 * refuse the same figures with the same sentence before it sends anything -- and this package is
 * the one a client bundle may evaluate. One table, so the CLI, the route and the panel cannot
 * drift apart on where a limit stops.
 *
 * The bounds are a floor and a ceiling on a person's own mistake, not a policy: five minutes is
 * shorter than any real run and three hours longer than any this product has seen finish; one run
 * at a time is the smallest project that runs at all, and ten is past what one host's CLIs carry;
 * one attempt is "never retry", and ten is past the point where a retry is still news.
 */

export type WorkspaceLimitField = 'runTimeoutMs' | 'maxConcurrentRuns' | 'maxAttempts'

const MINUTE_MS = 60_000

/** Inclusive bounds, in the column's own unit -- milliseconds for the timeout. */
export const WORKSPACE_LIMIT_BOUNDS: Readonly<Record<WorkspaceLimitField, { readonly min: number; readonly max: number }>> = {
  runTimeoutMs: { min: 5 * MINUTE_MS, max: 180 * MINUTE_MS },
  maxConcurrentRuns: { min: 1, max: 10 },
  maxAttempts: { min: 1, max: 10 },
}

/**
 * The sentence a refused figure is answered with, in the unit a person types it in: the timeout is
 * asked for in MINUTES everywhere a person sets it (`--run-timeout-min`, the panel's field), so a
 * refusal that quoted 300000..10800000 would be answering a question nobody asked.
 */
export const WORKSPACE_LIMIT_RULE: Readonly<Record<WorkspaceLimitField, string>> = {
  runTimeoutMs: `a run timeout must be a whole number of minutes from ${String(WORKSPACE_LIMIT_BOUNDS.runTimeoutMs.min / MINUTE_MS)} to ${String(WORKSPACE_LIMIT_BOUNDS.runTimeoutMs.max / MINUTE_MS)}`,
  maxConcurrentRuns: `runs at once must be a whole number from ${String(WORKSPACE_LIMIT_BOUNDS.maxConcurrentRuns.min)} to ${String(WORKSPACE_LIMIT_BOUNDS.maxConcurrentRuns.max)}`,
  maxAttempts: `attempts per task must be a whole number from ${String(WORKSPACE_LIMIT_BOUNDS.maxAttempts.min)} to ${String(WORKSPACE_LIMIT_BOUNDS.maxAttempts.max)}`,
}

/**
 * Whether `value` may be written to `field`. A whole number inside the bounds -- and, for the
 * timeout, a whole number of MINUTES: every writer asks for minutes, so a millisecond figure that
 * is not one is a caller that skipped the conversion, not a setting anybody chose.
 */
export function isWorkspaceLimitAllowed(field: WorkspaceLimitField, value: number): boolean {
  const { min, max } = WORKSPACE_LIMIT_BOUNDS[field]
  if (!Number.isInteger(value) || value < min || value > max) return false
  return field !== 'runTimeoutMs' || value % MINUTE_MS === 0
}
