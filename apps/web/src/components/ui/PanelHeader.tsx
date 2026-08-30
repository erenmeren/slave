import { SectionLabel } from './SectionLabel'

/**
 * The handoff's panel header (design README "Design Tokens" > Type: section labels 9px mono,
 * `letter-spacing: .09em`, uppercase) with the optional right action the 3a panels carry --
 * "all →" on Overview's live-events panel, for instance. `SectionLabel` is reused rather than
 * re-styled: it already IS the 9px/.09em recipe, and a second copy of it here is exactly the
 * duplication Decision 2 forbids.
 */
export function PanelHeader({
  title,
  action,
}: {
  readonly title: string
  readonly action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid="panel-header" className="flex items-baseline justify-between gap-2">
      <SectionLabel>{title}</SectionLabel>
      {action !== undefined && (
        <span data-testid="panel-header-action" className="font-mono text-[9.5px] text-text-3">
          {action}
        </span>
      )}
    </div>
  )
}
