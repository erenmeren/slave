/**
 * Turns an artifact's absolute log path into the short label the task panel shows (M23 C1).
 * Layout written by `apps/orchestrator/src/verify.ts`:
 *   `<repo>/.aiteamos/artifacts/<taskId>/attempt-NN/MM-<slug>.log`
 *   `<repo>/.aiteamos/artifacts/<taskId>/merge/attempt-NN/MM-<slug>.log` (merge re-verify)
 * `merge` wins over the attempt number when both are present -- a merge re-verify is what the
 * operator cares about, not which attempt's tree it re-ran against. Falls back to the bare
 * basename for anything that doesn't match this shape, so a future artifact `kind` never renders
 * blank.
 */
export function artifactLabel(path: string): string {
  const segments = path.split('/')
  const basename = segments[segments.length - 1] ?? path
  const logMatch = /^\d+-(.+)\.log$/.exec(basename)
  const slug = logMatch === null ? null : logMatch[1]
  if (slug === null) return basename

  if (segments.includes('merge')) return `merge · ${slug}`

  const attemptSegment = segments.find((segment) => /^attempt-(\d+)$/.test(segment))
  const attemptMatch = attemptSegment === undefined ? null : /^attempt-(\d+)$/.exec(attemptSegment)
  if (attemptMatch === null) return basename

  return `attempt ${Number(attemptMatch[1])} · ${slug}`
}
