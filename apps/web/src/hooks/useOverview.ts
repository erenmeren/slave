'use client'

import { useEffect, useRef, useState } from 'react'
import type { OverviewSnapshot } from '../server/overview.js'

export const REFETCH_DEBOUNCE_MS = 250

export interface OverviewState {
  readonly snapshot: OverviewSnapshot | null
  /** Live action line per agent id — overlays snapshot.agents[].actionLine (spec §6). */
  readonly actionLines: Readonly<Record<string, string>>
  readonly connection: 'connected' | 'reconnecting'
  /** Set when the latest refetch failed; the UI dims and shows it (spec §9). */
  readonly error: string | null
}

export function useOverview(workspaceId: string, initial: OverviewSnapshot): OverviewState {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(initial)
  const [actionLines, setActionLines] = useState<Record<string, string>>({})
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refetchSeq = useRef(0)

  useEffect((): (() => void) => {
    const refetch = async (): Promise<void> => {
      // Monotonic sequence guard: a slow refetch that started earlier must not clobber state with
      // a stale response after a later refetch (issued by a subsequent debounce window) has
      // already resolved. Only the most recently issued refetch is allowed to write state.
      const seq = ++refetchSeq.current
      try {
        const response = await fetch(`/api/w/${workspaceId}/overview`)
        if (!response.ok) throw new Error(`snapshot failed: ${response.status} ${await response.text()}`)
        const parsed = (await response.json()) as OverviewSnapshot
        if (seq !== refetchSeq.current) return
        setSnapshot(parsed)
        setError(null)
      } catch (cause) {
        if (seq !== refetchSeq.current) return
        // Keep the stale snapshot; name the failure (spec §9). The next event tries again.
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    const scheduleRefetch = (): void => {
      if (debounce.current !== null) clearTimeout(debounce.current)
      debounce.current = setTimeout((): void => {
        void refetch()
      }, REFETCH_DEBOUNCE_MS)
    }

    const source = new EventSource(`/api/w/${workspaceId}/events`)
    source.onopen = (): void => setConnection('connected')
    source.onerror = (): void => setConnection('reconnecting') // EventSource auto-reconnects
    source.onmessage = (message: { data: string }): void => {
      let event: { type?: string; agentId?: string; payload?: { summary?: string } }
      try {
        event = JSON.parse(message.data) as typeof event
      } catch {
        return // not ours to crash over (spec §9)
      }
      // A bare JSON primitive (`null`, `42`, `"x"`, ...) parses without throwing but is not an
      // object — reading `.type` off it would throw (or, for null, always throws). Same rule as
      // the parse failure above: not ours to crash over (spec §9).
      if (event === null || typeof event !== 'object') return

      // The one exception to the wake-up rule: the action line is display-only ephemera and paints
      // immediately. Wrong is fine — the next refetch overwrites it; it is not state (spec §6).
      if (event.type === 'run.tool_call' && typeof event.agentId === 'string') {
        const summary = event.payload?.summary
        if (typeof summary === 'string') {
          setActionLines((lines) => ({ ...lines, [event.agentId as string]: summary }))
        }
      }

      // Every event — recognized or not — is a wake-up (spec §6).
      if (typeof event.type === 'string') scheduleRefetch()
    }

    return (): void => {
      source.close()
      if (debounce.current !== null) clearTimeout(debounce.current)
    }
  }, [workspaceId])

  return { snapshot, actionLines, connection, error }
}
