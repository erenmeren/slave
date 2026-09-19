import { PanelHeader } from './PanelHeader'

/** The handoff panel surface (spec §3, M61 R16): `bg-panel` / `rounded-surface` by default,
 *  resting shadow. `floating` swaps that for the glass surface (`.glass` + `rounded-sheet`) that
 *  the right panel and other overlays draw -- same shell, translucent instead of opaque. */
export function Panel({
  title,
  action,
  floating = false,
  children,
}: {
  readonly title?: string
  /** The optional right-hand action the handoff's panel headers carry ("all →"). Ignored when
   *  `title` is absent -- an action with nothing to sit beside is a floating link. */
  readonly action?: React.ReactNode
  readonly floating?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = floating ? 'glass rounded-sheet' : 'bg-panel rounded-surface'
  return (
    <section data-testid="panel" className={`flex flex-col gap-3 border border-line p-4 shadow-resting ${surface}`}>
      {title !== undefined && <PanelHeader title={title} {...(action === undefined ? {} : { action })} />}
      {children}
    </section>
  )
}
