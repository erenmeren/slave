'use client'

import { useEffect, useRef } from 'react'

/** Everything the browser will focus, in document order. `:not([disabled])` and the negative
 *  tabindex filter keep a disabled confirm button and a decorative `tabindex="-1"` container out
 *  of the cycle. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The three keyboard promises a modal makes (M44 R3/R6), written ONCE.
 *
 * Before this, nine components each added their own `document.addEventListener('keydown', ...)`
 * for Escape, no drawer trapped Tab at all, and only `EmergencyStopButton` restored focus to its
 * trigger -- in a comment explaining how, rather than in shared code.
 *
 *   - Escape closes, unless `enabled` is false (a request is in flight and closing would leave the
 *     operator unsure whether it went through).
 *   - Tab and Shift+Tab cycle INSIDE the container, so a keyboard user cannot walk out of an open
 *     modal into the page behind it.
 *   - Whatever had focus when the modal opened gets it back when it closes -- read at open time,
 *     because by close time the trigger may have re-rendered.
 *
 * Returns the ref to put on the modal's container. Menus are NOT modals: `ProjectSwitcher` and
 * `graph/NodeMenu` keep their own Escape handling (plan erratum E22).
 */
export function useModalDismiss({
  open,
  onClose,
  enabled = true,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly enabled?: boolean
}): React.RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const first = container?.querySelector<HTMLElement>(FOCUSABLE) ?? null
    ;(first ?? container)?.focus()
    return () => {
      const restore = restoreRef.current
      restoreRef.current = null
      // `isConnected`: a trigger that unmounted while the modal was open (the two-step confirm
      // idiom replaces its own button) has nowhere to give focus back to, and focusing a detached
      // node silently moves focus to `<body>` instead.
      if (restore !== null && restore.isConnected) restore.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (enabled) onClose()
        return
      }
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (container === null) return
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, enabled, onClose])

  return containerRef
}
