'use client'

import { useSyncExternalStore } from 'react'

/**
 * M11 Task 10, ruling 2 (progress.md): the global shell's `<Sidebar>` mounts once in the root
 * layout (`app/layout.tsx`), which has no per-route params of its own to hand it a project name —
 * only the bare `workspaceId` derived from the pathname (`Sidebar.tsx`'s `workspaceIdFromPathname`).
 * A route that already knows its workspace's display name (its SSR'd snapshot) announces it here;
 * `Sidebar` reads it back via `useProjectName` below. Deliberately not React context: `<Sidebar>`
 * and the route's content are siblings under the root layout, not parent/child, so a context
 * provider would have to wrap both from the layout — this module-level store needs no shared
 * ancestor and leaves the layout's single, unconditional `<Sidebar>` mount untouched.
 */
interface Announcement {
  readonly workspaceId: string
  readonly name: string
}

let current: Announcement | null = null
const listeners = new Set<() => void>()

/** Called by a route's client component once it knows its workspace's display name. */
export function announceProjectName(workspaceId: string, name: string): void {
  if (current?.workspaceId === workspaceId && current.name === name) return
  current = { workspaceId, name }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): Announcement | null {
  return current
}

/** No announcement exists yet on the server (or before a route's effect runs) — same "fall back
 *  to the bare id" starting point the Sidebar already had. */
function getServerSnapshot(): Announcement | null {
  return null
}

/** The last-announced name for `workspaceId`, or null if nothing has announced it yet (a
 *  different workspace, or before the owning route's client component has mounted) — the caller
 *  falls back to the bare workspace id in that case, exactly as before this existed. */
export function useProjectName(workspaceId: string | null): string | null {
  const announcement = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (workspaceId === null || announcement === null || announcement.workspaceId !== workspaceId) return null
  return announcement.name
}
