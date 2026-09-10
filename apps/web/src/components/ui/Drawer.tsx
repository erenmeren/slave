'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * The right-hand drawer (M44 R3), with the same keyboard contract as `Dialog`. Its geometry is the
 * one the five existing drawers already shared, so adopting it in Task 4 changes no pixel.
 */
export function Drawer({
  open,
  onClose,
  label,
  testId,
  width = 'w-[520px]',
  dismissible = true,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly label: string
  readonly testId: string
  readonly width?: string
  readonly dismissible?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useModalDismiss({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-40 flex justify-end bg-black/40">
      <aside
        ref={ref as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        className={`flex ${width} max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]`}
      >
        {children}
      </aside>
    </div>
  )
}
