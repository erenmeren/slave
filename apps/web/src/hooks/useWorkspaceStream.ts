'use client'

import { useEffect, useRef, useState } from 'react'

export const REFETCH_DEBOUNCE_MS = 250

export interface StreamEvent {
  readonly seq?: number
  readonly type?: string
  readonly slaveId?: string
  readonly runId?: string
  readonly ts?: string
  readonly payload?: Record<string, unknown>
}

export interface WorkspaceStreamState<S> {
  readonly snapshot: S | null
  readonly connection: 'connected' | 'reconnecting'
  readonly error: string | null
  /**
   * Milliseconds between the server stamping an event (`ExecutionEvent.ts`) and this client
   * receiving the frame. `null` until the first data frame with a parseable `ts` arrives.
   *
   * NOT the heartbeat's round trip, and deliberately so: `server/sse.ts` writes its heartbeat as
   * an ID-ONLY frame (`id: <seq>\n\n`, no `data:`), which `EventSource` uses to advance
   * `lastEventId` and never surfaces as a `message` event — there is nothing in the browser to
   * time it against. An event's own arrival age measures the same path (append → LISTEN → SSE
   * write → browser) and is observable. Both clocks are the same machine (the product is
   * localhost-only), so skew is not a factor; clamped at 0 so a clock that ticks backwards shows
   * `0ms` rather than a negative age.
   */
  readonly latencyMs: number | null
}

/**
 * The SSE/refetch core shared by every workspace-scoped live view: connect to the workspace's
 * event stream, debounce a snapshot refetch on every wake-up event, and guard against a slow
 * refetch clobbering state after a newer one already landed. Extracted from M4's `useOverview` so
 * other snapshots (tasks, ...) can reuse the exact same wiring.
 */
export function useWorkspaceStream<S>(options: {
  readonly workspaceId: string
  readonly endpoint: string
  readonly initial: S
  readonly onEvent?: (event: StreamEvent) => void
  readonly onSnapshot?: (snapshot: S) => void
}): WorkspaceStreamState<S> {
  const { workspaceId, endpoint, initial } = options
  const [snapshot, setSnapshot] = useState<S | null>(initial)
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  const [error, setError] = useState<string | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refetchSeq = useRef(0)

  // Callbacks arrive via a ref updated every render so the effect below never needs them in its
  // dependency array — an identity change on `onEvent`/`onSnapshot` (a new inline closure each
  // render, say) must not tear down and reopen the EventSource.
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent
  const onSnapshotRef = useRef(options.onSnapshot)
  onSnapshotRef.current = options.onSnapshot

  useEffect((): (() => void) => {
    const refetch = async (): Promise<void> => {
      // Monotonic sequence guard: a slow refetch that started earlier must not clobber state with
      // a stale response after a later refetch (issued by a subsequent debounce window) has
      // already resolved. Only the most recently issued refetch is allowed to write state.
      const seq = ++refetchSeq.current
      try {
        const response = await fetch(endpoint)
        if (!response.ok) throw new Error(`snapshot failed: ${response.status} ${await response.text()}`)
        const parsed = (await response.json()) as S
        if (seq !== refetchSeq.current) return
        setSnapshot(parsed)
        onSnapshotRef.current?.(parsed)
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
    source.onopen = (): void => {
      setConnection('connected')
      // The snapshot was rendered before the stream's "from now" watermark was taken; an event
      // landing between the two is in neither. Refetching on open closes that gap — for the
      // first connect and every reconnect alike.
      scheduleRefetch()
    }
    source.onerror = (): void => setConnection('reconnecting') // EventSource auto-reconnects
    source.onmessage = (message: { data: string }): void => {
      let event: StreamEvent
      try {
        event = JSON.parse(message.data) as StreamEvent
      } catch {
        return // not ours to crash over (spec §9)
      }
      // A bare JSON primitive (`null`, `42`, `"x"`, ...) parses without throwing but is not an
      // object — reading `.type` off it would throw (or, for null, always throws). Same rule as
      // the parse failure above: not ours to crash over (spec §9).
      if (event === null || typeof event !== 'object') return

      // Stream latency (M14 §3): the age of this frame when it landed. See `latencyMs`'s docstring
      // for why the heartbeat cannot serve — it is an id-only frame and fires no `message` event.
      if (typeof event.ts === 'string') {
        const sentAt = Date.parse(event.ts)
        if (Number.isFinite(sentAt)) setLatencyMs(Math.max(0, Date.now() - sentAt))
      }

      onEventRef.current?.(event)

      // Every event — recognized or not — is a wake-up (spec §6).
      if (typeof event.type === 'string') scheduleRefetch()
    }

    return (): void => {
      source.close()
      if (debounce.current !== null) clearTimeout(debounce.current)
    }
  }, [workspaceId, endpoint])

  return { snapshot, connection, error, latencyMs }
}
