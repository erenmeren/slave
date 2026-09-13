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

// `formatTokens` was deleted by M53 R12 with the per-slave Analytics table, which its own docstring
// already named as "this function's one remaining caller" -- the flat worker list it was written for
// went in M24 and `AllSlavesTable` has no Tokens column. Nothing in this tree calls it, no test
// covers it, and no tile on `/analytics` has ever shown a token figure. An exported helper with no
// caller is a second thing to keep working for nobody.
