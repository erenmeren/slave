/**
 * H9b R1: whose failure a failed run was (`SlaveRun.failureClass`).
 *
 * `worker` is the work failing -- a terminal error, an unexcused denial, a gate. `platform` is
 * everything nothing the worker did could have changed: a spawn that never reached the model, a
 * process that died with the daemon, a provider that refused the call, a timeout decided after the
 * host slept. A platform failure spends nothing -- no breaker rung, no attempt, no planning or
 * review retry -- and the Supervisor reads it as `infrastructure`. A failed run with no class is a
 * row written before the column existed and reads as `worker`, which is how it counted then.
 */
export const FAILURE_CLASSES = ['worker', 'platform'] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

/**
 * The first wait after a provider `api_error` (F5). Sixty seconds is past a burst limit's window
 * and short enough that a passing overload costs the board a minute, not a morning.
 */
export const PROVIDER_ERROR_BACKOFF_MS = 60_000

/**
 * The ceiling the doubling stops at. An exhausted account does not come back in ten minutes, but a
 * retry every ten minutes costs one refused call each, and the moment the limit resets the board
 * moves again with nobody having to notice.
 */
export const PROVIDER_ERROR_BACKOFF_MAX_MS = 600_000

/**
 * How long to hold work back after `streak` consecutive provider refusals: 60 s, then doubling, to
 * at most {@link PROVIDER_ERROR_BACKOFF_MAX_MS}. Zero for no refusal at all.
 */
export function providerErrorBackoffMs(streak: number): number {
  if (streak <= 0) return 0
  // The exponent is clamped before `2 **` for the same reason the result is: a streak of a few
  // hundred is a real row count on an account that stayed exhausted for a day.
  return Math.min(PROVIDER_ERROR_BACKOFF_MS * 2 ** Math.min(streak - 1, 16), PROVIDER_ERROR_BACKOFF_MAX_MS)
}

/** One concluded run as {@link providerBackoffUntil} reads it. */
export interface BackoffRun {
  readonly providerError: boolean
  /** When the run concluded; a row with none is read at `startedAt`, the sort key's own fallback. */
  readonly concludedAt: Date
}

/**
 * The instant work that just met the provider's refusal may be tried again, or null when it may be
 * tried now.
 *
 * `latestFirst` is ONE line of work's concluded runs, newest first -- a task's implementation runs,
 * a task's review runs, or a workspace's planning runs. The streak is the unbroken run of
 * `providerError` rows at the head: anything else, a success or a failure of any other kind, is
 * the provider answering, and the next refusal starts over at sixty seconds.
 */
export function providerBackoffUntil(latestFirst: readonly BackoffRun[]): Date | null {
  const newest = latestFirst[0]
  if (newest === undefined || !newest.providerError) return null
  let streak = 0
  for (const run of latestFirst) {
    if (!run.providerError) break
    streak += 1
  }
  return new Date(newest.concludedAt.getTime() + providerErrorBackoffMs(streak))
}

/**
 * How many head rows {@link providerBackoffUntil} can ever need: the doubling reaches the ceiling
 * at the sixth refusal, so a seventh row changes nothing. A loader bounds its read with this.
 */
export const PROVIDER_BACKOFF_ROWS = 6
