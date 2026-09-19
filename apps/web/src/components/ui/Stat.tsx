import { TONE_TEXT, type StatusTone } from './StatusPill'

/**
 * A single labelled number (M61 R16) -- the spend/queue/headcount tiles the simple-mode header
 * and overview strips draw instead of `StatStrip`'s dense inline row. `testId` is required rather
 * than defaulted (the `Chip`/`SectionLabel` contract): a caller with several of these on one
 * screen needs to say which is which.
 */
export function Stat({
  testId,
  label,
  value,
  note,
  tone,
  unmeasured = false,
}: {
  readonly testId: string
  readonly label: React.ReactNode
  readonly value: React.ReactNode
  readonly note?: React.ReactNode
  /** Tints the value in a `StatusTone`'s text colour -- e.g. a blocked count in the `blocked`
   *  red. Untinted (`t1`, via `.type-heading`'s own colour) when omitted. */
  readonly tone?: StatusTone
  /** M61 Task 8 (plan erratum E4): stamps `data-unmeasured` on the tile -- Home's Spend tile
   *  carries this when any project's `unmeasuredRuns > 0`, so a gate or a test can find the
   *  caveat without parsing `note`'s own words. `false` (the default) renders no attribute at
   *  all, so every existing caller keeps its exact DOM. */
  readonly unmeasured?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      {...(unmeasured ? { 'data-unmeasured': 'true' } : {})}
      className="flex min-w-[110px] flex-col gap-0.5 rounded-surface border border-line bg-card px-3.5 py-2.5"
    >
      <span className="type-label">{label}</span>
      <span className={`type-heading ${tone ? TONE_TEXT[tone] : ''}`}>{value}</span>
      {note && <span className="type-meta text-t3">{note}</span>}
    </div>
  )
}
