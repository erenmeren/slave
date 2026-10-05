/** Lead UX design: the figures a person reads, said one way everywhere. */

/** `$4.20`; whole dollars stay whole (`$20`). */
export function formatUsd(usd: number): string {
  const rounded = Math.round(usd * 100) / 100
  return Number.isInteger(rounded) ? `$${String(rounded)}` : `$${rounded.toFixed(2)}`
}

/** The Limits card's spend line: "$4.20 of $20", "at least $4.20 of $20", "$4.20, no budget". */
export function spendLine(spentUsd: number, unmeasured: boolean, budgetUsd: number | null): string {
  const spent = `${unmeasured ? 'at least ' : ''}${formatUsd(spentUsd)}`
  return budgetUsd === null ? `${spent}, no budget` : `${spent} of ${formatUsd(budgetUsd)}`
}

/** Working time: "38 min", "1 h 5 min", "under a minute". */
export function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`
}

/** The Limits card's time line: "38 min of 1 h 30 min", "38 min, no time limit". */
export function timeLine(workedMs: number, limitMs: number | null): string {
  return limitMs === null ? `${formatMinutes(workedMs)}, no time limit` : `${formatMinutes(workedMs)} of ${formatMinutes(limitMs)}`
}

/** How long ago: "just now", "3 min ago", "2 h ago", "4 days ago". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)} h ago`
  return `${String(Math.round(hours / 24))} days ago`
}

/** A part of a whole as a bar's percentage, 0 to 100; null when there is no whole to measure against. */
export function percentOf(part: number, whole: number | null): number | null {
  if (whole === null || whole <= 0) return null
  return Math.min(100, Math.max(0, (part / whole) * 100))
}

/** "1 task", "3 tasks". */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : many}`
}
