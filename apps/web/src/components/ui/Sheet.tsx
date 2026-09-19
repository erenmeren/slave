'use client'

import { AnimatePresence, motion, useReducedMotion, type PanInfo } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useEscapeStack } from './useModalDismiss'
import { ScrollArea } from './ScrollArea'
import { DISMISS_TRAVEL, DISMISS_VELOCITY, EXIT, SPRING } from './motion'

/** Same set `useModalDismiss.ts`'s own `FOCUSABLE` names -- kept local rather than imported
 *  because `Sheet`'s Tab trap is scoped to `panelRef` (the panel itself, not the first focusable
 *  child, gets focus on open -- see the effect below), which is a different shape from that
 *  hook's bundled focus+escape+trap and not one this component reuses wholesale. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The right-hand (or bottom, on request) sheet (M61 R15/R16): `Drawer`'s keyboard contract --
 * Escape via `useEscapeStack`, a Tab trap, focus-in on open and focus-restore on close -- drawn
 * with `motion` instead of a plain CSS transition, on a glass surface, draggable-to-dismiss.
 *
 * Unlike `Drawer`/`Dialog` (which focus the first focusable descendant via `useModalDismiss`),
 * this focuses the PANEL itself (`tabIndex={-1}`) on open -- the panel is the thing a screen
 * reader should announce arriving, not whichever control happens to render first inside it.
 */
export function Sheet({
  open,
  onClose,
  title,
  testId,
  side = 'right',
  width = '440px',
  instant = false,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly testId: string
  readonly side?: 'right' | 'bottom'
  readonly width?: string
  /** Forces the no-motion path even when the OS allows animation -- a caller that needs a sheet to
   *  appear synchronously (e.g. driving it from a keyboard shortcut mid-flow) sets this rather than
   *  fighting the spring. */
  readonly instant?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const reduced = useReducedMotion() === true
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEscapeStack({ open, onEscape: onClose })

  // Focus the panel on open; give it back to whatever had it on close. Runs on the OUTER
  // component (always mounted), not on the `AnimatePresence`-controlled child -- so this fires the
  // moment `open` flips, regardless of how long the exit animation takes to finish removing the
  // DOM node.
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => restoreRef.current?.focus()
  }, [open])

  // Tab stays inside the panel -- a minimal version of `useModalDismiss`'s own trap, scoped to
  // `panelRef` because this component's own focus-on-open target is the panel, not the first
  // focusable child (see the effect above).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const container = panelRef.current
      if (container === null) return
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
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

  const axis = side === 'right' ? 'x' : 'y'
  const hidden = side === 'right' ? { transform: 'translateX(100%)' } : { transform: 'translateY(100%)' }
  const shown = { transform: side === 'right' ? 'translateX(0%)' : 'translateY(0%)' }
  const noMotion = reduced || instant

  const onDragEnd = (_e: unknown, info: PanInfo): void => {
    const size = axis === 'x' ? (panelRef.current?.offsetWidth ?? 1) : (panelRef.current?.offsetHeight ?? 1)
    const offset = axis === 'x' ? info.offset.x : info.offset.y
    const velocity = Math.abs(axis === 'x' ? info.velocity.x : info.velocity.y) / 1000
    if (offset > size * DISMISS_TRAVEL || (offset > 0 && velocity > DISMISS_VELOCITY)) onClose()
  }

  // Each target (`animate`/`exit`) carries its OWN `transition` -- the installed `motion` version
  // supports per-variant transitions this way (a `transition` key inside the target object itself,
  // not a reserved sibling key on the shared `transition` prop), which is what lets exit use
  // `EXIT`'s faster timing while enter uses `SPRING`.
  const enterTransition = noMotion ? { duration: reduced ? 0.15 : 0 } : SPRING
  const exitTransition = noMotion ? { duration: reduced ? 0.15 : 0 } : EXIT

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40" data-testid={`${testId}-root`}>
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={noMotion ? { duration: 0 } : { duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            data-testid={testId}
            data-side={side}
            className={`glass absolute flex flex-col border-line shadow-resting focus:outline-none ${
              side === 'right' ? 'inset-y-0 right-0 border-l rounded-l-sheet' : 'inset-x-0 bottom-0 max-h-[85dvh] border-t rounded-t-sheet'
            }`}
            {...(side === 'right' ? { style: { width } } : {})}
            initial={noMotion ? { opacity: 0 } : hidden}
            animate={{ ...(noMotion ? { opacity: 1 } : shown), transition: enterTransition }}
            exit={{ ...(noMotion ? { opacity: 0 } : hidden), transition: exitTransition }}
            drag={noMotion ? false : axis}
            dragConstraints={axis === 'x' ? { left: 0, right: 0 } : { top: 0, bottom: 0 }}
            dragElastic={{ [axis === 'x' ? 'left' : 'top']: 0.05, [axis === 'x' ? 'right' : 'bottom']: 0.6 }}
            onDragEnd={onDragEnd}
          >
            <header className="flex h-[48px] items-center gap-3 border-b border-line px-4">
              <h2 className="type-title m-0 flex-1 truncate">{title}</h2>
              <button
                type="button"
                data-testid="sheet-close"
                aria-label="Close"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-control text-t2 hover:bg-hover hover:text-t1"
              >
                ×
              </button>
            </header>
            <ScrollArea testId={`${testId}-body`} className="p-4">
              {children}
            </ScrollArea>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
