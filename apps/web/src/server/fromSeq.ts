/**
 * Parse a resume watermark from `Last-Event-ID` or `?from`. Only a non-negative integer counts;
 * anything else — including the empty string, which `Number()` reads as 0 and would replay the
 * entire event log — means "from now" (null).
 */
export function parseFromSeq(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}
