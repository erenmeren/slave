'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * A centred modal (M44 R3). Owns Escape, the Tab trap, focus restore and `aria-modal` through
 * `useModalDismiss`; the caller owns the content and the verbs. `dismissible={false}` while a
 * request is in flight, so neither Escape nor the scrim can close a dialog mid-POST.
 *
 * `z-20` is `AssignCompanyDialog`'s own layer, the only centred dialog in the app today, so
 * adopting this in Task 4 changes no stacking. (It therefore sits BELOW the `z-30` `Drawer`: no
 * surface opens a dialog from inside a drawer today, and whichever milestone first does has to
 * raise this deliberately rather than discover it.)
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
  const ref = useModalDismiss<HTMLDivElement>({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-20 flex items-center justify-center p-4">
      {/* A real `<button>`, not a `<div onMouseDown>`: clicking away from a modal is an action, and
          the three surfaces that hand-rolled this all reached for `aria-label="close"` too. It
          sits OUTSIDE the container ref, so it is not part of the Tab cycle. */}
      <button
        type="button"
        aria-label="close"
        data-testid={`${testId}-scrim`}
        onClick={() => {
          if (dismissible) onClose()
        }}
        className="absolute inset-0 bg-black/50"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        className="relative flex w-[420px] max-w-full flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        {children}
      </div>
    </div>
  )
}
