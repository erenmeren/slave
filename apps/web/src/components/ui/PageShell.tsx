import type React from 'react'
import { SectionLabel } from './SectionLabel'

/**
 * The one page frame (M44 R3): the same gutters, the same title row and the same tabs slot on
 * every page, so a new surface does not have to guess at them. `md:` is the only breakpoint --
 * below it the gutters tighten and the title row wraps (M44 R6).
 *
 * It owns the FRAME, never the content: no page's panels move into it, and it fetches nothing.
 *
 * `min-h-0` (Task 9 review, fix round 1, Important 2): a one-class addition that helps every page
 * a bounded scroll region wants to sit inside and breaks none -- it only matters to an element
 * inside a flex COLUMN (this frame's own `flex-col`) whose parent already bounds ITS height, and
 * does nothing otherwise. Without it, `flex-1` alone still lets this frame grow to fit an
 * unbounded descendant's content (flexbox's own "automatic minimum size" default) instead of that
 * descendant shrinking to fit the frame -- which is what a page with its own internal
 * `min-h-0 flex-1` scroll region (e.g. `PeopleTable`'s virtualized table) needs from every
 * ancestor between it and the viewport.
 *
 * `children` render inside their OWN `flex min-h-0 flex-1 flex-col` wrapper now (M61 Task 10):
 * the title row and `tabs` slot stay outside it (they are fixed, never scrolling), so a page
 * whose whole body is one `ui/ScrollArea` gets a bounded ancestor for free and needs no flex
 * wrapper of its own at all (`EvidenceTab`, `SkillsClient`'s two columns). A page with more than
 * one top-level element still carries its OWN `flex min-h-0 flex-1 flex-col` div, same as
 * before -- this wrapper only guarantees that div's own PARENT is bounded rather than growing to
 * fit it, one more link in the chain rather than a replacement for the page's own. `flush` is
 * unaffected: it only ever touched the ROOT's own `gap-4 p-3 md:p-4`, and this wrapper carries no
 * padding or gap of its own either way.
 */
export function PageShell({
  title,
  action,
  tabs,
  testId = 'page-shell',
  flush,
  children,
}: {
  readonly title?: string
  readonly action?: React.ReactNode
  readonly tabs?: React.ReactNode
  readonly testId?: string
  /**
   * Drop the frame's own gutters and gap (M44 erratum E25, M45 plan erratum E18).
   *
   * `PageShell` is `gap-4 p-3 md:p-4`, and every `/w/:id/*` page already carries its own
   * `px-[20px] pt-[16px]` from the design handoff. Wrapping them as-is would move pixels on five
   * pages whose design this milestone does not change -- and `gate:m14-fidelity` screenshots four
   * of them. `flush` is how those pages get the shell's LANDMARK and its `page-shell` marker with
   * no visual change at all; a page that has no gutters of its own should not use it.
   */
  readonly flush?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testId} className={`flex min-h-0 min-w-0 flex-1 flex-col ${flush === true ? '' : 'gap-4 p-3 md:p-4'}`}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title === undefined ? <span /> : <SectionLabel>{title}</SectionLabel>}
          {action}
        </div>
      )}
      {tabs}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
