'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * A centred modal (M44 R3). Owns Escape, the Tab trap, focus restore and `aria-modal` through
 * `useModalDismiss`; the caller owns the content and the verbs. `dismissible={false}` while a
 * request is in flight, so Escape cannot close a dialog mid-POST.
 */
export function Dialog({
  open,
  onClose,
  label,
  testId,
  dismissible = true,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly label: string
  readonly testId: string
  readonly dismissible?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useModalDismiss({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        className="flex w-[420px] max-w-full flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        {children}
      </div>
    </div>
  )
}
