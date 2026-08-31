/** The handoff section label (spec §3): 9px mono, uppercase, `.09em` tracking. */

/** The one mono section/field caption recipe (design handoff "Design Tokens"): every consumer
 *  composes this constant so the seven call sites cannot drift apart again (M11 review item). */
export const SECTION_LABEL_CLASS = 'font-mono text-[9px] uppercase tracking-[.09em] text-text-3'

export function SectionLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid="section-label" className={SECTION_LABEL_CLASS}>
      {children}
    </div>
  )
}
