import { TONE_BORDER, TONE_TEXT, type StatusTone } from './StatusPill'
import { LiveDot } from './LiveDot'

/** The handoff chip (spec §3, M61 R16): a small labelled pill, neutral by default or tinted to a
 *  `StatusTone` -- a `LiveDot` carries the colour now, so the chip itself is border + text only,
 *  no tinted fill (`StatusPill`'s own M61 rewrite drops the same fill). */
export function Chip({
  tone,
  title,
  testId = 'chip',
  children,
}: {
  readonly tone?: StatusTone
  /** The raw value behind a projected word (M44 R5) -- the same contract `StatusPill`'s own
   *  `title` carries. */
  readonly title?: string
  /**
   * A NAME for one chip, where a surface has several and a test or a gate must say which (M46 R6).
   * Defaults to `chip`, which is the handle four gates and five tests already read -- passing this
   * replaces it rather than adding a second, because an element has one `data-testid`, and the
   * Workforce Catalog's rows need `catalog-capability-chip` to be countable inside a row that also
   * carries a role chip and two marker chips.
   */
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = tone !== undefined ? `${TONE_BORDER[tone]} ${TONE_TEXT[tone]}` : 'border-line bg-bg-2 text-text-2'
  return (
    <span data-testid={testId} data-tone={tone} {...(title === undefined ? {} : { title })} className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs ${surface}`}>
      {tone !== undefined && <LiveDot tone={tone} pulse={false} />}
      {children}
    </span>
  )
}
