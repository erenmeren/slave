'use client'

import { useSyncExternalStore } from 'react'

/** What a workspace page's `useWorkspaceStream` knows about its own connection, published for
 *  the project header's chip (M24 §2.2). A module store for the same reason `useShellFacts.ts`
 *  is one: the header is mounted by the layout, the stream by the page, and neither is the
 *  other's ancestor. One workspace at a time. */
export interface StreamState {
  readonly connection: 'connected' | 'reconnecting'
  readonly latencyMs: number | null
}

interface Publication {
  readonly workspaceId: string
  readonly state: StreamState
}

let current: Publication | null = null
const listeners = new Set<() => void>()

export function publishStreamState(workspaceId: string, state: StreamState | null): void {
  if (state === null) {
    if (current === null || current.workspaceId !== workspaceId) return
    current = null
  } else {
    if (
      current?.workspaceId === workspaceId &&
      current.state.connection === state.connection &&
      current.state.latencyMs === state.latencyMs
    ) {
      return
    }
    current = { workspaceId, state }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getSnapshot(): Publication | null {
  return current
}
function getServerSnapshot(): Publication | null {
  return null
}

/** `null` before the page's stream has published — the header shows `sse · —` then. */
export function useStreamState(workspaceId: string): StreamState | null {
  const published = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (published === null || published.workspaceId !== workspaceId) return null
  return published.state
}
