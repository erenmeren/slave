'use client'

import { usePathname } from 'next/navigation'
import { useSyncExternalStore } from 'react'
import { workspaceIdOf } from '../../lib/routes'
import { useRightPanel } from './RightPanelProvider'
import type { RightWidth } from './AppShell'

/** Below this width the panel leaves the grid and becomes a fixed overlay (M61 R14, spec R4: "the
 *  panel narrows from 372 to 340 to fit 1024 with a usable middle... below 1280 the panel's track
 *  is `none` and the panel renders as an OVERLAY"). */
const NARROW = '(max-width: 1279px)'

/** jsdom (every component test) has no `matchMedia` at all -- guarded with `?.` rather than
 *  stubbed globally, so a test that never touches this hook never has to know it exists, and one
 *  that does (`app-shell.test.tsx`'s overlay case, if it ever renders `ShellFrame` rather than
 *  `AppShell` directly) stubs it the way `theme.test.tsx` does. Absence reads as "not narrow". */
function subscribe(cb: () => void): () => void {
  const query = window.matchMedia?.(NARROW)
  query?.addEventListener('change', cb)
  return () => query?.removeEventListener('change', cb)
}

function isNarrow(): boolean {
  return window.matchMedia?.(NARROW).matches ?? false
}

/** How wide the third column is right now — read by the shell through a render prop rather than
 *  by `AppShell` itself, which is a server component and has no pathname.
 *
 *  The server snapshot is `false` (not narrow): the server has no `matchMedia` to read, so the
 *  first client render has to agree with it or hydration mismatches -- exactly the flat-`false`
 *  rule `ThemeProvider`'s `systemDark` state already keeps. The real width is read a beat later, on
 *  the client, once `useSyncExternalStore` re-subscribes past hydration. */
export function useRightWidth(): RightWidth {
  const pathname = usePathname()
  const { collapsed } = useRightPanel()
  const narrow = useSyncExternalStore(subscribe, isNarrow, () => false)
  if (workspaceIdOf(pathname) === null) return 'none'
  if (collapsed) return 'dock'
  return narrow ? 'overlay' : 'panel'
}
