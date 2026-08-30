import type { DayCount } from '../server/analytics'

const COLUMN_WIDTH = 28
const GAP = 14

/**
 * The 7-day stacked bar chart, hand-rolled SVG — no chart library (spec §5.9). Named `BarChart`
 * rather than folded into `Sparkline`: `Sparkline` draws ONE polyline from a bucket array and is
 * consumed by the agent card and the activity header; a stacked two-series bar chart with day
 * labels and value captions shares none of that geometry, and widening `Sparkline` to cover both
 * would leave every existing caller passing flags it does not use.
 *
 * Successes in the `working` teal, failures in `#f87171` (design README §3a.8), drawn as plain
 * SVG rects. Heights are normalized to the BUSIEST day's total, not to a fixed ceiling: seven bars
 * scaled to an arbitrary maximum would render a quiet week as seven slivers, and the chart's job
 * is comparing days against each other. A day with zero runs draws a zero-height segment (a
 * measured zero, not a placeholder) rather than being omitted.
 */
export function BarChart({
  series,
  height,
  label,
}: {
  readonly series: readonly DayCount[]
  readonly height: number
  readonly label: string
}): React.JSX.Element {
  const max = Math.max(1, ...series.map((day) => day.succeeded + day.failed))
  const width = series.length * COLUMN_WIDTH + (series.length - 1) * GAP

  return (
    <svg role="img" aria-label={label} width="100%" height={height + 28} viewBox={`0 0 ${width} ${height + 28}`} xmlns="http://www.w3.org/2000/svg">
      {series.map((day, index) => {
        const x = index * (COLUMN_WIDTH + GAP)
        const okHeight = Math.round((day.succeeded / max) * height)
        const failHeight = Math.round((day.failed / max) * height)
        return (
          <g key={day.day} data-testid="bar-column" data-day={day.day}>
            <rect
              data-testid={`bar-fail-${day.day}`}
              x={x}
              y={height - okHeight - failHeight}
              width={COLUMN_WIDTH}
              height={failHeight}
              rx="2"
              fill="rgba(248,113,113,.55)"
            />
            <rect
              data-testid={`bar-ok-${day.day}`}
              x={x}
              y={height - okHeight}
              width={COLUMN_WIDTH}
              height={okHeight}
              rx="2"
              fill="var(--color-tone-working)"
            />
            <text x={x + COLUMN_WIDTH / 2} y={height + 16} textAnchor="middle" className="fill-text-3 font-mono text-[9.5px]">
              {/* `2026-08-25` → `08-25`: the year is the same for all seven and costs width. */}
              {day.day.slice(5)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
