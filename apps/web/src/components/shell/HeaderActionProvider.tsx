'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * The header's page-action slot (M57 R7).
 *
 * CONTEXT, not a DOM portal, and not a module store. A portal would need a ref to a header element
 * that does not exist during the server's render; a module store would hold a detached React
 * subtree across a route change. Context works here for a reason it did NOT work in M24: the
 * header is mounted by the ROOT layout now, which is an ancestor of every page, where
 * `ProjectHeader` was a sibling of `{children}` inside the project layout (`useShellFacts.ts:11-16`
 * is the note that explains why that forced a module store then).
 *
 * A page calls `useHeaderAction(<Button .../>)` and the node appears in the header; when that page
 * unmounts the effect's cleanup clears it, so a page action never outlives its page.
 */
interface HeaderActionStore {
  readonly node: React.ReactNode
  readonly setNode: (node: React.ReactNode) => void
}

const HeaderActionContext = createContext<HeaderActionStore | null>(null)

export function HeaderActionProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [node, setNodeState] = useState<React.ReactNode>(null)
  const setNode = useCallback((next: React.ReactNode): void => setNodeState(next), [])
  const value = useMemo<HeaderActionStore>(() => ({ node, setNode }), [node, setNode])
  return <HeaderActionContext.Provider value={value}>{children}</HeaderActionContext.Provider>
}

/**
 * Put this page's primary action in the header.
 *
 * The dependency is the CALLER's responsibility in exactly one way: pass a node built from stable
 * values, or memoise it, because a fresh element on every render would set state on every render.
 * Every call site in this milestone passes a node whose only moving part is a `useCallback`'d
 * handler, and the `deps` argument is how that is declared.
 */
export function useHeaderAction(node: React.ReactNode, deps: readonly unknown[]): void {
  const store = useContext(HeaderActionContext)
  const setNode = store?.setNode
  useEffect((): (() => void) | undefined => {
    if (setNode === undefined) return undefined
    setNode(node)
    return (): void => setNode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `node` is rebuilt every render by
    // construction; `deps` is the caller's declaration of what actually changed inside it.
  }, [setNode, ...deps])
}

/** What the header renders in its slot. `null` on a page that declared no action. */
export function useHeaderActionNode(): React.ReactNode {
  return useContext(HeaderActionContext)?.node ?? null
}
