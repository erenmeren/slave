import type React from 'react'

const AXIS = { y: 'overflow-y-auto overflow-x-hidden', x: 'overflow-x-auto overflow-y-hidden', both: 'overflow-auto' } as const

/** The ONE scrolling region (M61 R4). The page never scrolls; this does. `min-h-0` + `flex-1` is
 *  what lets it take the rest of a flex column instead of pushing the column taller than the frame. */
export function ScrollArea({
  axis = 'y',
  className = '',
  testId = 'scroll-area',
  children,
}: {
  readonly axis?: keyof typeof AXIS
  readonly className?: string
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      data-scroll-axis={axis}
      className={`min-h-0 min-w-0 flex-1 [overscroll-behavior:contain] ${AXIS[axis]} ${className}`}
    >
      {children}
    </div>
  )
}
