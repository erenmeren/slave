import type React from 'react'

/** How wide the third column is right now (M57 R4). `none` removes it from the grid entirely
 *  rather than sizing it to zero: a zero-width track still takes the gap and still lets a
 *  `min-width` inside it push the layout. */
export type RightWidth = 'panel' | 'dock' | 'none'

const TRACK: Record<RightWidth, string> = {
  panel: '236px minmax(0, 1fr) 372px',
  dock: '236px minmax(0, 1fr) 52px',
  none: '236px minmax(0, 1fr)',
}

/**
 * The frame (M57 R4): sidebar · main · right panel, as ONE grid.
 *
 * A grid and not four nested flexes, because the three columns have to agree about the height of
 * the viewport and about what scrolls: `min-h-screen` on the grid plus `min-h-0` on each column is
 * the shape where the sidebar, the page and the panel each scroll independently and the header
 * never moves. Four nested flexes can be made to do it and cannot be read.
 *
 * `min-w-[1280px]` is the README's own floor. It REPLACES M44's `max-[899px]` sidebar collapse
 * (which went with `Sidebar.tsx`): the prototype is a desktop operator console and the handoff
 * states a minimum width rather than a breakpoint. This is a deliberate reduction in responsive
 * behaviour, it is named in the spec (R4) and in `docs/ia.md`, and it is not an oversight.
 *
 * It declares no `'use client'` and holds no state — it takes nodes and arranges them. That does
 * NOT make it a server component in the built tree: Task 5's `'use client'` `ShellFrame` imports it
 * directly, which pulls it into the client bundle (scan finding 44). What the absence of the
 * directive actually buys is that it can be rendered from EITHER side — the root layout composes
 * `<SidebarTree initial={projects}/>` on the server and hands it down as a prop through client
 * providers, so the server's own read still reaches the first paint.
 */
export function AppShell({
  sidebar,
  header,
  right,
  rightWidth,
  children,
}: {
  readonly sidebar: React.ReactNode
  readonly header: React.ReactNode
  /** The 372px panel, the 52px dock, or nothing. Sized by `rightWidth`, not by itself. */
  readonly right: React.ReactNode
  readonly rightWidth: RightWidth
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="app-shell"
      data-right={rightWidth}
      style={{ gridTemplateColumns: TRACK[rightWidth] }}
      className="grid min-h-screen min-w-[1280px] bg-bg text-t1"
    >
      {sidebar}
      {/* The middle column owns the header and the scroll. `min-w-0` so a wide table inside a page
        * scrolls itself instead of stretching the grid; `min-h-0` so the page scrolls under a
        * header that stays put. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {header}
        {/* The one `main` landmark, and the skip link's target (M44 R6, unchanged). `tabIndex={-1}`
          * so the anchor can actually move focus here. */}
        <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
      {right}
    </div>
  )
}
