/** The handoff section label (spec §3): 9px mono, uppercase, `.09em` tracking. */
export function SectionLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid="section-label" className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
      {children}
    </div>
  )
}
