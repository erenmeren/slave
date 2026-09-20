import type React from 'react'
import { forwardRef } from 'react'

const AXIS = { y: 'overflow-y-auto overflow-x-hidden', x: 'overflow-x-auto overflow-y-hidden', both: 'overflow-auto' } as const

/**
 * The ONE scrolling region (M61 R4). The page never scrolls; this does. `min-h-0` + `flex-1` is
 * what lets it take the rest of a flex column instead of pushing the column taller than the frame.
 *
 * A `forwardRef` since M61 R16: `DataTable`'s `virtualized` mode needs the raw scroll element for
 * `useVirtualizer`'s `getScrollElement` (the same idiom `activity/Timeline.tsx` uses on its own
 * bare `<div>`), and every other caller keeps rendering exactly as before -- a `ref` prop is
 * simply optional on a `forwardRef` component, same as on any native element.
 */
export const ScrollArea = forwardRef<
  HTMLDivElement,
  {
    readonly axis?: keyof typeof AXIS
    readonly className?: string
    readonly testId?: string
    /** M61 R10/Task 7: `activity/Timeline.tsx`'s own scroll-position tracking (pinned/near-top)
     *  needs the raw scroll event, the same way `DataTable`'s virtualized mode needs the raw
     *  scroll ELEMENT above -- optional, and every other caller that never passes it sees no
     *  change at all. */
    readonly onScroll?: (event: React.UIEvent<HTMLDivElement>) => void
    readonly children: React.ReactNode
  }
>(function ScrollArea({ axis = 'y', className = '', testId = 'scroll-area', onScroll, children }, ref): React.JSX.Element {
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-scroll-axis={axis}
      {...(onScroll === undefined ? {} : { onScroll })}
      className={`min-h-0 min-w-0 flex-1 [overscroll-behavior:contain] ${AXIS[axis]} ${className}`}
    >
      {children}
    </div>
  )
})

// `forwardRef` erases the render function's own name from React's devtools label; this puts it
// back, mirroring `ui/Button`'s own `displayName` fix.
ScrollArea.displayName = 'ScrollArea'
