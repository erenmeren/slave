import { PanelHeader } from './PanelHeader'

/** The handoff panel surface (spec §3): `bg-bg-1`, radius 9, resting shadow. */
export function Panel({
  title,
  action,
  children,
}: {
  readonly title?: string
  /** The optional right-hand action the handoff's panel headers carry ("all →"). Ignored when
   *  `title` is absent -- an action with nothing to sit beside is a floating link. */
  readonly action?: React.ReactNode
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid="panel" className="flex flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-resting">
      {title !== undefined && <PanelHeader title={title} {...(action === undefined ? {} : { action })} />}
      {children}
    </section>
  )
}
