/** The handoff section label (spec §3, M61 R16): `.type-label` -- sentence case, no more
 *  uppercase/mono. Uppercase tracked mono captions are gone in simple mode; mono is reserved for
 *  `technical` lines and developer-mode identifiers (`globals.css`'s own `.type-label` comment). */

/** The one section/field caption recipe (design handoff "Design Tokens"): every consumer
 *  composes this constant so the call sites cannot drift apart again (M11 review item). */
export const SECTION_LABEL_CLASS = 'type-label'

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
