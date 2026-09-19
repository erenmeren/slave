/**
 * `860000` → `14m 20s`; `45000` → `45s`.
 *
 * Lives here, not in `server/analytics.ts` where it was first written, because it is also needed by
 * `'use client'` components -- `AnalyticsClient.tsx`'s per-slave table until M53 R12 deleted it, and
 * the Evidence tab's median-duration column since. `server/analytics.ts` imports
 * `@slave-of-ai/db/client` at module scope, and Next's
 * client bundler resolves an entire module's imports before any tree-shaking of unused exports
 * happens — a client component that value-imports even one pure export from that file drags
 * `pg`'s Node-only dependency graph (`fs`, `net`, `tls`, `dns`) into the browser bundle and fails
 * `next build`. This module has no such side effect, so both the server aggregator and the client
 * table can import it directly instead of one re-implementing the other's formatting and risking
 * the two disagreeing.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes === 0 ? `${rest}s` : `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/** `1800000` → `30m`; `90000` → `1m30s`; `45000` → `45s`. A duration a person reads, not a
 *  millisecond count — moved here from `Sidebar.tsx` (M24 §2.1) so Task 4's Runtime panel can
 *  import it too. */
export function formatTimeout(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

/**
 * `2026-09-19T10:58:00.000Z` (with `now` five minutes later) → `5m ago`; under a minute →
 * `just now` (M61 R7).
 *
 * The Command strip's `NeedsYouBar` is this function's first caller -- a needs-you item's age
 * beside its title, the way the handoff's rows read. Nothing in this tree had a RELATIVE clock
 * before this (`GoalHistory.tsx`/`NeedsYouCard.tsx` both print the absolute `toLocaleString()`
 * stamp instead), so this is a new function rather than a moved one. `now` is a parameter, not
 * `Date.now()` read inside, so a test can pin the age without faking the system clock.
 */
export function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso))
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ago`
}

// `formatTokens` was deleted by M53 R12 with the per-slave Analytics table, which its own docstring
// already named as "this function's one remaining caller" -- the flat worker list it was written for
// went in M24 and `AllSlavesTable` has no Tokens column. Nothing in this tree calls it, no test
// covers it, and no tile on `/analytics` has ever shown a token figure. An exported helper with no
// caller is a second thing to keep working for nobody.
