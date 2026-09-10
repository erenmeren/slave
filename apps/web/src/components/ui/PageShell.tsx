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
  children,
}: {
  readonly title?: string
  readonly action?: React.ReactNode
  readonly tabs?: React.ReactNode
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 flex-col gap-4 p-3 md:p-4">
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
