import { TONE_DOT, type StatusTone } from './StatusPill'

/** In-flight tones (spec §3 / handoff "Motion": "status dots pulse 1.5s ease-in-out (only for
 *  in-flight states)") -- the pipeline's active-class states. `blocked`/`done`/`paused`/`idle`
 *  are at-rest states and stay static. Same set `StatusPill` used to keep as its own
 *  `IN_FLIGHT_TONES` before M61 R16 pulled the dot out into this component; `StatusPill` and
 *  `Chip` both render it now instead of drawing their own dot. */
const PULSE: ReadonlySet<StatusTone> = new Set(['working', 'planning', 'review', 'waiting'])

/**
 * The one status dot (M61 R16): a solid 6px circle in the tone's colour, pulsing for the four
 * in-flight tones unless the caller silences it. `StatusPill` and `Chip` both compose this rather
 * than drawing their own `<span>` -- one dot recipe, one pulse rule.
 */
export function LiveDot({
  tone,
  pulse,
  testId,
}: {
  readonly tone: StatusTone
  /** Silences the tone's own in-flight default when `false`; does not force a pulse for a tone
   *  outside `PULSE` (there is nothing to render pulsing that isn't already in-flight). */
  readonly pulse?: boolean
  readonly testId?: string
}): React.JSX.Element {
  const pulseClass = PULSE.has(tone) && pulse !== false ? 'motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]' : ''
  return (
    <span
      data-testid={testId ?? 'live-dot'}
      data-tone={tone}
      className={`inline-block h-[6px] w-[6px] rounded-pill ${TONE_DOT[tone]} ${pulseClass}`}
    />
  )
}
