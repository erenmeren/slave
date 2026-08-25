import { TONE_BORDER, TONE_FILL, TONE_TEXT } from './ui/StatusPill'

export function HaltBanner({ reason }: { readonly reason: string }): React.JSX.Element {
  return (
    // Recolours onto `ui/StatusPill.tsx`'s `blocked` tone tokens, not a literal `status-danger`
    // string: `globals.css` documents `--status-danger`/`--tone-blocked` as the same `#f87171`
    // ("halt, failed, over budget" is `status-danger`'s own listed use), so this also picks up
    // spec §3's alpha pattern (fill ~10%, border ~24%) in place of the ad-hoc `/40` border alpha
    // this banner had before. No test pins a class here (`overview-components.test.tsx` asserts
    // only `role="alert"` and text content).
    <div role="alert" className={`border-b px-4 py-2 text-sm ${TONE_FILL.blocked} ${TONE_BORDER.blocked} ${TONE_TEXT.blocked}`}>
      workspace halted: {reason} — retract with <code className="font-mono">clear-halt</code> (CLI)
    </div>
  )
}
