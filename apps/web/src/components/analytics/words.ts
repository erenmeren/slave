import type { AnalyticsDays, AnalyticsView, DayMoney, EvidenceRate } from '@slave-of-ai/control'
import { formatUsd, plural } from '@/lib/format'

/** The Analytics page's words and arithmetic, as plain functions: the page and its tests share them. */

export const PERIODS: readonly { readonly days: AnalyticsDays; readonly id: string; readonly word: string }[] = [
  { days: 7, id: '7', word: '7 days' },
  { days: 30, id: '30', word: '30 days' },
  { days: null, id: 'all', word: 'All time' },
]

/** Where a choice of project and period lives: 30 days of every project is the bare address. */
export function analyticsHref(projectId: string | null, days: AnalyticsDays): string {
  const params = new URLSearchParams()
  if (projectId !== null) params.set('project', projectId)
  if (days !== 30) params.set('days', days === null ? 'all' : String(days))
  const query = params.toString()
  return query === '' ? '/analytics' : `/analytics?${query}`
}

/** The same choice as the read's address. */
export function analyticsApi(projectId: string | null, days: AnalyticsDays): string {
  return analyticsHref(projectId, days).replace('/analytics', '/api/analytics')
}

export function periodWord(days: AnalyticsDays): string {
  return days === null ? 'in all' : `in the last ${String(days)} days`
}

/** What can make a sum of money less than what was really spent. */
export interface Gaps {
  readonly unmeasuredSessions: number
  readonly liveSessions: number
}

export const partial = (gaps: Gaps): boolean => gaps.unmeasuredSessions > 0 || gaps.liveSessions > 0

/**
 * A sum of money as it may honestly be said: the figure; "at least" in front when a session's cost
 * is missing from it; and words in place of a zero that is only a not-yet.
 */
export function moneyWord(usd: number, gaps: Gaps): string {
  if (!partial(gaps)) return formatUsd(usd)
  if (usd > 0) return `at least ${formatUsd(usd)}`
  return gaps.liveSessions > 0 ? 'not reported yet' : 'not reported'
}

/** One part of a sum in a table: a dash where nothing was spent on it. */
export function partWord(usd: number): string {
  return usd > 0 ? formatUsd(usd) : '—'
}

/** Why a sum is "at least", in a sentence; null when it is whole. */
export function gapSentence(gaps: Gaps): string | null {
  const parts: string[] = []
  if (gaps.liveSessions > 0) parts.push(`${plural(gaps.liveSessions, 'session is', 'sessions are')} still open, and a session reports its cost when it ends`)
  if (gaps.unmeasuredSessions > 0) parts.push(`${plural(gaps.unmeasuredSessions, 'session')} ended without reporting a cost`)
  if (parts.length === 0) return null
  const sentence = parts.join('; ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

/**
 * What one step cost; a dash when there is no step or no figure to divide, and when a session's
 * cost is missing and what is left comes to under a cent -- that would read as "nearly free".
 */
export function perStepWord(usd: number, steps: number, gaps: Gaps): string {
  if (steps === 0 || usd <= 0) return '—'
  const each = usd / steps
  if (each < 0.01) return partial(gaps) ? '—' : 'under $0.01'
  return partial(gaps) ? `at least ${formatUsd(each)}` : formatUsd(each)
}

/** A rate as a cell: the percentage and what it is of, or why none is claimed. */
export function rateWord(rate: EvidenceRate): string {
  if (rate.pct !== null) return `${String(rate.pct)}% of ${String(rate.judged)}`
  return rate.judged === 0 ? 'Not judged yet' : 'Not enough evidence yet'
}

/** `2026-10-05` as `Oct 5`. */
export function dayWord(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Which days carry a label under a chart: all of a week, about five of anything longer, the newest always. */
export function labelledDays(count: number): ReadonlySet<number> {
  const every = count <= 8 ? 1 : Math.ceil(count / 5)
  const shown = new Set<number>()
  for (let index = count - 1; index >= 0; index -= every) shown.add(index)
  return shown
}

/** A round number at or above `max` for the top of a chart's scale: 1, 2 or 5 times a power of ten. */
export function niceCeiling(max: number): number {
  if (max <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  const step = [1, 2, 5, 10].find((multiple) => multiple * power >= max) ?? 10
  return step * power
}

/** The tones a chart tells projects apart by, in order; a fifth project and beyond share the last. */
export const SERIES_TONES = ['bg-info', 'bg-success', 'bg-checking', 'bg-warning'] as const
export const OTHER_TONE = 'bg-muted-foreground/50'
export const OTHER_SERIES = 'other'

export interface Series {
  readonly id: string
  readonly name: string
  readonly tone: string
}

/**
 * The projects a money chart stacks, the biggest spender first: the first four have a tone of
 * their own, the rest are drawn together as "Other projects".
 */
export function seriesOf(days: readonly DayMoney[], projects: AnalyticsView['projects']): readonly Series[] {
  const totals = new Map<string, number>()
  for (const day of days) for (const part of day.byProject) totals.set(part.projectId, (totals.get(part.projectId) ?? 0) + part.usd)
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const named = ranked.slice(0, SERIES_TONES.length).map((id, index): Series => ({ id, name: projects.find((project) => project.id === id)?.name ?? 'A deleted project', tone: SERIES_TONES[index] ?? OTHER_TONE }))
  return ranked.length > SERIES_TONES.length ? [...named, { id: OTHER_SERIES, name: 'Other projects', tone: OTHER_TONE }] : named
}

export interface Column {
  readonly day: string
  readonly total: number
  /** Bottom first. */
  readonly segments: readonly { readonly id: string; readonly value: number; readonly tone: string; readonly name: string }[]
}

/** A day of money as a stacked column of the chart's series. */
export function moneyColumns(days: readonly DayMoney[], series: readonly Series[]): readonly Column[] {
  const own = new Set(series.map((one) => one.id))
  return days.map((day) => ({
    day: day.day,
    total: day.totalUsd,
    segments: series.flatMap((one) => {
      const value = one.id === OTHER_SERIES ? day.byProject.filter((part) => !own.has(part.projectId)).reduce((total, part) => total + part.usd, 0) : (day.byProject.find((part) => part.projectId === one.id)?.usd ?? 0)
      return value > 0 ? [{ id: one.id, value, tone: one.tone, name: one.name }] : []
    }),
  }))
}
