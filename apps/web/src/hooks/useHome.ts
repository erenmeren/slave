'use client'

import { useEffect, useState } from 'react'
// Runtime import, not `../server/home.js`: that module imports `@slave-of-ai/db/client` at module
// scope, and a client hook value-importing even one pure export from it drags `pg`'s Node-only
// dependency graph (`fs`, `net`, `tls`, `dns`) into the browser bundle and fails `next build` --
// the same boundary `useOverview.ts` documents for `server/overview.ts` (controller ruling R3).
import type { HomeSnapshot } from '../server/home'

/** Mirrors `server/home.ts`'s own `HOME_POLL_MS` (10s) -- duplicated rather than imported, for the
 *  type-only reason above; a value import would pull Prisma into the browser bundle. */
const HOME_POLL_MS = 10_000

/**
 * Home's own poll (M61 R11): `GET /api/home` every `HOME_POLL_MS`, but only while the tab is
 * actually visible -- a background tab holds the snapshot it already has rather than spending a
 * request nobody is looking at -- plus one immediate refetch on the `visibilitychange` that brings
 * the tab back into view, so a person returning to a stale tab sees current numbers without
 * waiting out the rest of the interval.
 *
 * NO fetch on mount: `initial` is the server's own render, already fresh, and re-asking for it the
 * instant the page paints would be a request that could only ever repeat what the server already
 * sent. `initial` changing (a prop from a fresh server render, e.g. after `router.refresh()`)
 * replaces the held snapshot the same way `NeedsYouBar.tsx`'s own `initial` effect does.
 */
export function useHome(initial: HomeSnapshot, archived: boolean): HomeSnapshot {
  const [snapshot, setSnapshot] = useState(initial)

  useEffect((): void => {
    setSnapshot(initial)
  }, [initial])

  useEffect((): (() => void) => {
    const controller = new AbortController()

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/home${archived ? '?archived=1' : ''}`, { signal: controller.signal })
        // Belt-and-braces (M61 Task 8 review, item 4): a real aborted `fetch` REJECTS (caught
        // below), but a request that was already in flight when unmount fired can still resolve
        // after `controller.abort()` ran -- and a test double that does not implement abort
        // semantics at all would resolve regardless. Checked again after the `await`, not only
        // relied on via the `signal` passed above, so a state update can never land on an
        // unmounted hook either way.
        if (controller.signal.aborted) return
        if (!response.ok) return
        const next = (await response.json()) as HomeSnapshot
        if (controller.signal.aborted) return
        setSnapshot(next)
      } catch {
        // Keep the snapshot we have -- a page that empties itself because one poll failed is worse
        // than one that is a few seconds stale (`ProjectSwitcher.tsx`'s own rule).
      }
    }

    const tick = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void load()
    }

    const timer = setInterval(tick, HOME_POLL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return (): void => {
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [archived])

  return snapshot
}
