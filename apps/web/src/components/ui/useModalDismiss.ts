'use client'

import { useEffect, useRef } from 'react'

/** Everything the browser will focus, in document order. `:not([disabled])` and the negative
 *  tabindex filter keep a disabled confirm button and a decorative `tabindex="-1"` container out
 *  of the cycle. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Every layer that wants Escape, innermost last (M44 R3 fix round 1).
 *
 * Both `useModalDismiss` and `DangerConfirm` listen on `document`, so without this a
 * `DangerConfirm` inside a `Drawer` would take one Escape and close BOTH -- the operator cancels a
 * confirm and loses the drawer they were working in. Only the top entry acts; everything below it
 * ignores the key entirely.
 *
 * Module-level and LIFO by mount order, which is the right order because nested layers open
 * SEQUENTIALLY: a drawer is open before anything inside it can be, and `DangerConfirm` always
 * starts closed (its `open` is internal state, never a prop), so the inner layer always registers
 * after the outer one. Two layers that opened in the same commit would register children-first,
 * which React's effect order makes unavoidable and which no surface here does.
 */
const escapeStack: object[] = []

/**
 * Escape for ONE layer, ordered against every other layer (see `escapeStack`).
 *
 * `enabled: false` (a request is in flight) still SWALLOWS the key rather than letting it fall
 * through to the layer below -- a dialog that cannot be closed must not close its parent instead.
 */
export function useEscapeStack({
  open,
  enabled = true,
  onEscape,
}: {
  readonly open: boolean
  readonly enabled?: boolean
  readonly onEscape: () => void
}): void {
  // One stable identity per hook instance; `{}` is enough, it is only ever compared by reference.
  const tokenRef = useRef<object>({})

  // Registration keys off `open` ALONE. Folding it into the listener effect below would re-push
  // the token every time a caller passes a fresh inline `onClose`, silently promoting an outer
  // layer above the inner one that is actually on top.
  useEffect(() => {
    if (!open) return
    const token = tokenRef.current
    escapeStack.push(token)
    return () => {
      const at = escapeStack.lastIndexOf(token)
      if (at !== -1) escapeStack.splice(at, 1)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const token = tokenRef.current
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (escapeStack[escapeStack.length - 1] !== token) return
      if (!enabled) return
      onEscape()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, enabled, onEscape])
}

/**
 * The three keyboard promises a modal makes (M44 R3/R6), written ONCE.
 *
 * Before this, nine components each added their own `document.addEventListener('keydown', ...)`
 * for Escape, no drawer trapped Tab at all, and only `EmergencyStopButton` restored focus to its
 * trigger -- in a comment explaining how, rather than in shared code.
 *
 *   - Escape closes, unless `enabled` is false (a request is in flight and closing would leave the
 *     operator unsure whether it went through), and only for the innermost open layer.
 *   - Tab and Shift+Tab cycle INSIDE the container, so a keyboard user cannot walk out of an open
 *     modal into the page behind it. `enabled` does NOT gate this: a modal that refuses to close
 *     still has to hold focus.
 *   - Whatever had focus when the modal opened gets it back when it closes -- read at open time,
 *     because by close time the trigger may have re-rendered.
 *
 * Returns the ref to put on the modal's container. Menus are NOT modals: `ProjectSwitcher` and
 * `graph/NodeMenu` keep their own Escape handling (plan erratum E22).
 */
export function useModalDismiss<T extends HTMLElement>({
  open,
  onClose,
  enabled = true,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly enabled?: boolean
}): React.RefObject<T | null> {
  const containerRef = useRef<T | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEscapeStack({ open, enabled, onEscape: onClose })

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
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (container === null) return
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) {
        // Nothing inside is focusable right now -- every control disabled mid-POST, or a
        // progress-only dialog. Letting Tab through would walk focus out of an `aria-modal`
        // container into the page behind it, which is the one thing the trap exists to prevent;
        // swallowing the key leaves focus on the container (which carries `tabIndex={-1}`).
        event.preventDefault()
        return
      }
      const active = document.activeElement
      // Symmetric at both ends, and from the container itself: forward Tab off the last (or off
      // the container) lands on the first, Shift+Tab off the first (or off the container) lands on
      // the last.
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || active === container)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return containerRef
}
