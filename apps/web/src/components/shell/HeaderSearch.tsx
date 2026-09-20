import type React from 'react'

/**
 * The `⌘K` field (M61 R5), moved verbatim -- markup and behaviour -- out of `SidebarTree.tsx` and
 * into the header, `search` where it was `sidebar-search`.
 *
 * RENDERED and INERT (spec §6 names it): the README draws it, a missing control would read as an
 * unfinished design, and a control that looked live but did nothing would be worse than either.
 * `aria-disabled` is how it says so to a screen reader, and it is not focusable.
 */
export function HeaderSearch(): React.JSX.Element {
  return (
    <div
      data-testid="search"
      aria-disabled="true"
      className="flex w-[200px] items-center gap-2 rounded-card border border-line2 bg-card px-[10px] py-[6px] text-[12.5px] text-t3"
    >
      <span className="flex-1">Search or jump…</span>
      <span className="font-mono text-[11px] font-medium">⌘K</span>
    </div>
  )
}
