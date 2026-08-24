import { TONE_DOT, TONE_GLOW, type StatusTone } from './StatusPill'

/**
 * The handoff progress bar (spec §3): `width` transitions `.5s ease`, with the tone's "0 0 8px"
 * glow — motion gated behind `prefers-reduced-motion` via `motion-safe:`, per the milestone's
 * global motion rule. `pct` is clamped to [0, 100] so a caller passing an out-of-range value (a
 * stale snapshot, a rounding overshoot) never renders an overflowing or negative-width bar.
 */
export function ProgressBar({
  pct,
  tone = 'working',
}: {
  readonly pct: number
  readonly tone?: StatusTone
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div data-testid="progress-bar" className="h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
      <div
        data-testid="progress-bar-fill"
        className={`h-full motion-safe:[transition:width_.5s_ease] ${TONE_DOT[tone]} ${TONE_GLOW[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
