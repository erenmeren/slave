'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * The right-hand drawer (M44 R3), with the same keyboard contract as `Dialog`. Its geometry, its
 * scrim and its `z-30` layer are the ones the five existing drawers already shared (the scrim is a
 * `flex-1` sibling rather than a full-bleed overlay, so the drawer itself stays unshaded), so
 * adopting it in Task 4 changes no pixel and no stacking.
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
  const ref = useModalDismiss<HTMLElement>({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-30 flex justify-end">
      {/* `aria-label="close"` and the `flex-1 bg-black/50` shape are verbatim the five drawers'
          own scrim. It sits OUTSIDE the container ref, so it is not part of the Tab cycle. */}
      <button
        type="button"
        aria-label="close"
        data-testid={`${testId}-scrim`}
        onClick={() => {
          if (dismissible) onClose()
        }}
        className="flex-1 bg-black/50"
      />
      <aside
        ref={ref}
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
