/** The handoff section label (spec §3): 9px mono, uppercase, `.09em` tracking. */

/** The one mono section/field caption recipe (design handoff "Design Tokens"): every consumer
 *  composes this constant so the seven call sites cannot drift apart again (M11 review item). */
export const SECTION_LABEL_CLASS = 'font-mono text-[9px] uppercase tracking-[.09em] text-text-3'

export function SectionLabel({
  testId = 'section-label',
  children,
}: {
  /**
   * A NAME for one label, where a surface has several and a test or a gate must say which -- the
   * `Chip` contract, word for word. Defaults to `section-label`, which four gates and a dozen tests
   * already read, and REPLACES it rather than adding a second: an element has one `data-testid`, and
   * a caption wrapped in a span to carry a name of its own is a wrapper standing in for a prop
   * (M47 t4 fix round 1, nit 7).
   */
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testId} className={SECTION_LABEL_CLASS}>
      {children}
    </div>
  )
}
