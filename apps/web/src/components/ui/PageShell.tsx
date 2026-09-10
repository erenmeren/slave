import type React from 'react'
import { SectionLabel } from './SectionLabel'

/**
 * The one page frame (M44 R3): the same gutters, the same title row and the same tabs slot on
 * every page, so a new surface does not have to guess at them. `md:` is the only breakpoint --
 * below it the gutters tighten and the title row wraps (M44 R6).
 *
 * It owns the FRAME, never the content: no page's panels move into it, and it fetches nothing.
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
    <div data-testid={testId} className={`flex min-w-0 flex-1 flex-col ${flush === true ? '' : 'gap-4 p-3 md:p-4'}`}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title === undefined ? <span /> : <SectionLabel>{title}</SectionLabel>}
          {action}
        </div>
      )}
      {tabs}
      {children}
    </div>
  )
}
