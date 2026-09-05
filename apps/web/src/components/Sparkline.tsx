/**
 * Pure-SVG tool-call sparkline (spec Task 9) — no charting library. `buckets` is the `number[10]`
 * shape from Task 4 (overview + activity) / Task 5 (the hook's live-rotated copy): one count per
 * minute, oldest first.
 *
 * Points are scaled against `max(buckets, 1)` so an all-zero window still divides cleanly — every
 * point lands on the baseline (y = height), rendering a flat line along the bottom edge rather
 * than collapsing to nothing. That flat baseline is deliberate: it is the "stuck slave" cue (an
 * slave with zero tool calls for the last 10 minutes), so it must render as a visible line, not
 * an empty svg.
 *
 * Stroke is `currentColor` — no new colour tokens. The parent sets the text colour (a muted token
 * for the card's mini variant, per the brief) and the line picks it up for free.
 */
export function Sparkline({
  buckets,
  width,
  height,
  label,
}: {
  readonly buckets: readonly number[]
  readonly width: number
  readonly height: number
  readonly label: string
}): React.JSX.Element {
  const max = Math.max(...buckets, 1)
  const count = buckets.length
  const step = count > 1 ? width / (count - 1) : width

  const points = buckets
    .map((value, index) => {
      const x = index * step
      const y = height - (value / max) * height
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
