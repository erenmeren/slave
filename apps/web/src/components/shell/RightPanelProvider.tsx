'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

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

export function RightPanelProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
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
      onCloseRef.current = onClose
      setMode(next)
      setContent(node)
      // Un-collapse only when something NEW is being opened (scan finding 21). A person who
      // collapsed the panel on a live project would otherwise have it re-open within a second and
      // permanently: the owning page re-runs its mirror effect on every SSE frame, and an
      // unconditional `setCollapsed(false)` turns that into an un-collapse loop. A click that
      // produces no visible change is a click a person repeats — so a genuinely new subject still
      // un-collapses, and only a re-assertion of the same one does not.
      const nextKey = `${next}:${key ?? ''}`
      if (openKeyRef.current !== nextKey) setCollapsed(false)
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

  const collapse = useCallback((): void => setCollapsed(true), [])
  const expand = useCallback((): void => setCollapsed(false), [])

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
