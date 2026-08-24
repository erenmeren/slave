/** The handoff panel surface (spec §3): `bg-bg-1`, radius 9, resting shadow. */
export function Panel({
  title,
  children,
}: {
  readonly title?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid="panel" className="flex flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-resting">
      {title !== undefined && (
        <h3 data-testid="panel-title" className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
          {title}
        </h3>
      )}
      {children}
    </section>
  )
}
