import { TONE_DOT, TONE_GLOW, type StatusTone } from './StatusPill'

/**
 * The handoff progress bar (spec §3): `width` transitions `.5s ease`, with the tone's "0 0 8px"
 * glow — motion gated behind `prefers-reduced-motion` via `motion-safe:`, per the milestone's
 * global motion rule. `pct` is clamped to [0, 100] so a caller passing an out-of-range value (a
 * stale snapshot, a rounding overshoot) never renders an overflowing or negative-width bar.
 *
 * `size` is the handoff's one thickness difference and nothing else: the agent card's bar is 3px
 * (design README "1a — Control Room"), every table row's is the 6px `h-1.5` this component has
 * always drawn. A prop rather than a second component, because a copy would be the same fill, the
 * same clamp, the same glow and the same transition with one number changed.
 */
const TRACK_HEIGHT: Record<'default' | 'card', string> = {
  default: 'h-1.5',
  card: 'h-[3px]',
}

export function ProgressBar({
  pct,
  tone = 'working',
  size = 'default',
}: {
  readonly pct: number
  readonly tone?: StatusTone
  readonly size?: 'default' | 'card'
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div data-testid="progress-bar" className={`w-full overflow-hidden rounded-full bg-bg-2 ${TRACK_HEIGHT[size]}`}>
      <div
        data-testid="progress-bar-fill"
        className={`h-full motion-safe:[transition:width_.5s_ease] ${TONE_DOT[tone]} ${TONE_GLOW[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
