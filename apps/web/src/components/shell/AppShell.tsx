import type React from 'react'

/** How wide the third column is right now (M57 R4, widened by M61 R4/R14). `none` removes it from
 *  the grid entirely rather than sizing it to zero: a zero-width track still takes the gap and
 *  still lets a `min-width` inside it push the layout. `overlay` is ALSO a two-track grid (below
 *  1280px the panel leaves the grid and `RightPanelHost` draws it `position: fixed` instead) --
 *  `data-right` still tells the two apart, because one of them has a project and the other does
 *  not. */
export type RightWidth = 'panel' | 'dock' | 'none' | 'overlay'

const TRACK: Record<RightWidth, string> = {
  panel: '56px minmax(0, 1fr) 340px',
  dock: '56px minmax(0, 1fr) 52px',
  none: '56px minmax(0, 1fr)',
  overlay: '56px minmax(0, 1fr)',
}

/**
 * The frame (M57 R4, M61 R4/R5): rail · main · right panel, as ONE grid.
 *
 * A grid and not four nested flexes, because the three columns have to agree about the height of
 * the viewport and about what scrolls. M61 R4 changes WHAT scrolls: the grid is `h-dvh` (the
 * viewport, not the document) and `<main>` is `overflow-hidden` -- the page itself never scrolls
 * any more, and every page places its scrolling content inside `ui/ScrollArea` instead. `min-h-0`
 * on the middle column still matters: it is what lets that inner `ScrollArea` size itself against
 * the header rather than against its own content.
 *
 * `min-w-[1024px] min-h-[680px]` is the M61 README's own floor, DOWN from M57's `min-w-[1280px]`
 * (which itself replaced M44's `max-[899px]` sidebar collapse): a desktop app window is smaller
 * than a browser tab, and the rail shrinking from 236px to 56px (R5 -- the tree became a switcher)
 * is most of what makes the lower floor fit a usable middle column. Below the floor the shell
 * scrolls as a whole, exactly as it did below 1280 before.
 *
 * It declares no `'use client'` and holds no state — it takes nodes and arranges them. That does
 * NOT make it a server component in the built tree: `ShellFrame`'s `'use client'` imports it
 * directly, which pulls it into the client bundle (scan finding 44). What the absence of the
 * directive actually buys is that it can be rendered from EITHER side — the root layout composes
 * `<Rail/>` on the server and hands it down as a prop through client providers, so the server's own
 * read still reaches the first paint.
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
  /** The 340px panel, the 52px dock, the fixed overlay, or nothing. Sized by `rightWidth`, not by
   *  itself -- `overlay` renders here as `null` (the grid stays two tracks) and `RightPanelHost`
   *  draws the actual surface `position: fixed`, outside this element entirely. */
  readonly right: React.ReactNode
  readonly rightWidth: RightWidth
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="app-shell"
      data-right={rightWidth}
      style={{ gridTemplateColumns: TRACK[rightWidth] }}
      className="grid h-dvh min-h-[680px] min-w-[1024px] bg-bg text-t1"
    >
      {sidebar}
      {/* The middle column owns the header; the page below it owns no scroll of its own any more
        * (M61 R4) -- `min-w-0` so a wide table still scrolls itself sideways rather than stretching
        * the grid, `min-h-0` so whatever `ui/ScrollArea` the page renders has a bounded box to fill. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {header}
        {/* The one `main` landmark, and the skip link's target (M44 R6, unchanged). `tabIndex={-1}`
          * so the anchor can actually move focus here. `overflow-hidden`, not `overflow-y-auto`:
          * `<main>` never scrolls (M61 R4) -- every page places its own `ScrollArea` inside it. */}
        <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none">
          {children}
        </main>
      </div>
      {right}
    </div>
  )
}
