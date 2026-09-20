'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { workspaceIdOf } from '../../lib/routes'
import { matchesShortcut } from '../../lib/shortcuts'
import { SUPERVISOR_STORAGE_KEY, isSupervisorChoice, type SupervisorChoice } from '../../lib/supervisorStorage'

/** What the 372px slot is showing (M57 R8). `supervisor` is the DEFAULT on every `/w/:id/*` route;
 *  `task` and `slave` replace it while one is selected and hand it back when it closes. */
export type RightPanelMode = 'supervisor' | 'task' | 'slave'

export interface RightPanelState {
  /** `null` means "the default for this route": the Supervisor inside a project, nothing outside. */
  readonly mode: RightPanelMode | null
  readonly collapsed: boolean
  readonly content: React.ReactNode
  /**
   * Show `content` in the slot. `onClose` is the OWNING PAGE's clearer -- the same call that clears
   * `?task=`/`?slave=` -- so the panel header's own `»` and the page's close button do the same
   * thing (plan erratum E5). A mode opened without one closes the panel and leaves the URL, which
   * is a bug the type cannot prevent, so the parameter is required.
   */
  readonly open: (mode: RightPanelMode, content: React.ReactNode, onClose: () => void, key?: string) => void
  /** Hand the slot back to its default, calling the owner's clearer on the way. */
  readonly close: () => void
  readonly collapse: () => void
  readonly expand: () => void
}

const RightPanelContext = createContext<RightPanelState | null>(null)

/** Every `localStorage` touch is wrapped: a private window, blocked site data, or a browser that
 *  throws on the accessor itself must degrade to "open this session", never to a blank page --
 *  same rule `ThemeProvider`'s/`ModeProvider`'s own `writeStored` keep. */
function writeSupervisorChoice(choice: SupervisorChoice): void {
  try {
    window.localStorage.setItem(SUPERVISOR_STORAGE_KEY, choice)
  } catch {
    /* the state above still applies this session */
  }
}

/**
 * `RightPanelProvider` (M61 R14): the Supervisor's open/collapsed state is now REMEMBERED, the same
 * `flat first render, catch up after mount` shape `ThemeProvider`/`ModeProvider` use -- `collapsed`
 * starts `false` (open) because the server has no `localStorage` to read, and a mount effect below
 * reads the stored choice once the component is on the client for certain.
 */
export function RightPanelProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname()
  const [mode, setMode] = useState<RightPanelMode | null>(null)
  const [content, setContent] = useState<React.ReactNode>(null)
  const [collapsed, setCollapsed] = useState(false)
  // A ref, not state: changing the clearer must not re-render the tree, and it is only ever read
  // inside `close`.
  const onCloseRef = useRef<(() => void) | null>(null)

  /** What is currently open, as a string, so a re-`open()` with the same mode and the same subject
   *  can be told from a genuinely new one. A ref because reading it must not re-render. */
  const openKeyRef = useRef<string | null>(null)

  const open = useCallback(
    (next: RightPanelMode, node: React.ReactNode, onClose: () => void, key?: string): void => {
      const nextKey = `${next}:${key ?? ''}`
      // Is this a genuinely NEW subject, or the same one re-asserted? One answer, two consequences.
      const changed = openKeyRef.current !== nextKey
      // THE SLOT ONLY HOLDS ONE THING (ruling T3-4). Opening a task while a slave is open evicts
      // the slave, and the page that owned it has to be told, or its `?slave=` stays in the URL and
      // its mirror effect re-opens the panel on the next frame -- two owners fighting over one
      // slot. The OLD clearer runs before it is replaced, and only when something else is taking
      // the slot: re-asserting the same subject must not clear the URL that describes it.
      if (changed) onCloseRef.current?.()
      onCloseRef.current = onClose
      setMode(next)
      setContent(node)
      // Un-collapse only when something NEW is being opened (scan finding 21). A person who
      // collapsed the panel on a live project would otherwise have it re-open within a second and
      // permanently: the owning page re-runs its mirror effect on every SSE frame, and an
      // unconditional `setCollapsed(false)` turns that into an un-collapse loop. A click that
      // produces no visible change is a click a person repeats — so a genuinely new subject still
      // un-collapses, and only a re-assertion of the same one does not.
      //
      // M61 R14: this rule still applies unchanged, and now ALSO writes `'open'` -- a person who
      // had the panel remembered as collapsed and then opened a task from the board is choosing
      // "open" exactly as much as a click on the collapse button chooses "collapsed", and the next
      // load should remember it that way too.
      if (changed) {
        setCollapsed(false)
        writeSupervisorChoice('open')
      }
      openKeyRef.current = nextKey
    },
    [],
  )

  const close = useCallback((): void => {
    const onClose = onCloseRef.current
    onCloseRef.current = null
    openKeyRef.current = null
    setMode(null)
    setContent(null)
    onClose?.()
  }, [])

  const collapse = useCallback((): void => {
    setCollapsed(true)
    writeSupervisorChoice('collapsed')
  }, [])
  const expand = useCallback((): void => {
    setCollapsed(false)
    writeSupervisorChoice('open')
  }, [])

  // The stored choice, read once the component is on the client for certain (M61 R14) -- the same
  // shape `ThemeProvider`'s/`ModeProvider`'s own mount effects use. Absent (or anything that is not
  // exactly `'collapsed'`) reads as OPEN, which is already this state's flat first value, so there
  // is nothing to do for that case.
  useEffect((): void => {
    try {
      const raw = window.localStorage.getItem(SUPERVISOR_STORAGE_KEY)
      if (isSupervisorChoice(raw) && raw === 'collapsed') setCollapsed(true)
    } catch {
      /* stays open, the same as a browser with no storage at all */
    }
  }, [])

  // `Mod+J` toggles the panel (M61 R14) -- lives HERE, not on a per-page component, so it works on
  // every route that has a panel without every one of those routes wiring its own listener. Only
  // acts on a project route: outside one there is no panel for it to toggle, and a global `Mod+J`
  // would otherwise silently flip the remembered choice for the NEXT project a person opens. A
  // keyboard toggle animates nothing (spec R14), which is already true here -- `collapsed` drives a
  // CSS-free grid-track change, not a transitioned one.
  useEffect((): (() => void) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesShortcut(event, { key: 'j' })) return
      if (workspaceIdOf(pathname) === null) return
      event.preventDefault()
      if (collapsed) expand()
      else collapse()
    }
    window.addEventListener('keydown', onKeyDown)
    return (): void => window.removeEventListener('keydown', onKeyDown)
  }, [pathname, collapsed, collapse, expand])

  const value = useMemo<RightPanelState>(
    () => ({ mode, collapsed, content, open, close, collapse, expand }),
    [mode, collapsed, content, open, close, collapse, expand],
  )
  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>
}

/** Throws outside the provider: every consumer is inside the root layout's by construction, and a
 *  silently inert panel would hide the wiring bug. */
export function useRightPanel(): RightPanelState {
  const value = useContext(RightPanelContext)
  if (value === null) throw new Error('useRightPanel must be used inside <RightPanelProvider>')
  return value
}
