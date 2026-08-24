import { TONE_BORDER, TONE_FILL, TONE_TEXT, type StatusTone } from './StatusPill.js'

/** The handoff chip (spec §3): a small labelled pill, neutral by default or tinted to a
 *  `StatusTone` using the same `1a`-alpha fill / `3d`-alpha border pattern as `StatusPill`. */
export function Chip({
  tone,
  children,
}: {
  readonly tone?: StatusTone
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = tone !== undefined ? `${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}` : 'border-line bg-bg-2 text-text-2'
  return (
    <span data-testid="chip" data-tone={tone} className={`inline-flex items-center rounded-chip border px-2 py-0.5 text-xs ${surface}`}>
      {children}
    </span>
  )
}
