/**
 * `860000` → `14m 20s`; `45000` → `45s`.
 *
 * Lives here, not in `server/analytics.ts` where it was first written, because it is also needed
 * by `AnalyticsClient.tsx` (a `'use client'` component) to render the per-agent table's average
 * duration. `server/analytics.ts` imports `@ai-team-os/db/client` at module scope, and Next's
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
