'use client'

import { useEffect, useRef, useState } from 'react'
import type { ExecutionEvent } from '@ai-team-os/domain'
import { feedSummary } from '../lib/feedSummary'
import { filtersToQuery, type ActivityFilters } from '../lib/activityFilters'
// Type-only: `../server/activity` pulls in `prisma`, which must never reach the client bundle
// (controller ruling R3 — the same reasoning `useOverview.ts` follows for `OverviewSnapshot`).
import type { ActivityEventRow, ActivityHistoryPage, ActivityPage } from '../server/activity'

/** One bucket per minute, oldest-first — mirrors `bucketSparkline`'s window in `server/activity.ts`. */
const SPARKLINE_ROTATE_MS = 60_000

export interface ActivityStreamState {
  readonly events: readonly ActivityEventRow[]
  readonly connection: 'connected' | 'reconnecting'
  readonly loadOlder: () => void
  readonly loadingOlder: boolean
  readonly exhausted: boolean
  readonly sparkline: readonly number[]
  readonly error: string | null
}

/** `undefined` (an SSE envelope's optional fields) adapted to `null` (the row shape) — the same
 *  adaptation the stream route (Task 3) makes server-side before calling `eventMatchesFilters`. */
function rowFromEnvelope(event: ExecutionEvent): ActivityEventRow {
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    actor: event.actor,
    agentId: event.agentId ?? null,
    taskId: event.taskId ?? null,
    runId: event.runId ?? null,
    payload: event.payload as Record<string, unknown>,
    summary: feedSummary(event.type, event.payload as Record<string, unknown>),
  }
}

/** Ascending merge-append with de-duplication by `seq`. */
function appendRow(events: readonly ActivityEventRow[], row: ActivityEventRow): readonly ActivityEventRow[] {
  if (events.some((existing) => existing.seq === row.seq)) return events
  return [...events, row]
}

function streamUrl(workspaceId: string, filters: ActivityFilters, fromSeq: number): string {
  const params = new URLSearchParams(filtersToQuery(filters))
  params.set('from', String(fromSeq))
  return `/api/w/${workspaceId}/activity/stream?${params.toString()}`
}

function historyUrl(workspaceId: string, filters: ActivityFilters, extra?: Record<string, string>): string {
  const params = new URLSearchParams(filtersToQuery(filters))
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)
  const query = params.toString()
  return `/api/w/${workspaceId}/activity${query === '' ? '' : `?${query}`}`
}

/**
 * The activity timeline's client hook: a filtered live log seeded from a server-rendered first
 * page, with cursor-paginated history above it and a live-rotating sparkline. Standalone rather
 * than built on `useWorkspaceStream` — that hook's contract is "debounce a snapshot refetch on
 * every event"; this one keeps a growing, de-duplicated, filtered event buffer instead, and has
 * to close/reopen its own `EventSource` when the filters change, which `useWorkspaceStream`
 * has no hook for.
 */
export function useActivityStream(options: {
  readonly workspaceId: string
  readonly filters: ActivityFilters
  readonly initial: ActivityPage
}): ActivityStreamState {
  const { workspaceId, filters, initial } = options
  const filterKey = filtersToQuery(filters)

  const [events, setEvents] = useState<readonly ActivityEventRow[]>(() => [...initial.events].reverse())
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [sparkline, setSparkline] = useState<readonly number[]>(initial.sparkline)
  const [error, setError] = useState<string | null>(null)

  // Refs so the mount effect (deps `[workspaceId, filterKey]`) always reads the *current* value
  // without needing it in its dependency array — the same identity-churn technique
  // `useWorkspaceStream` uses for its callbacks.
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const initialRef = useRef(initial)
  initialRef.current = initial
  const hasMountedRef = useRef(false)

  const eventsRef = useRef(events)
  eventsRef.current = events
  const nextBeforeRef = useRef(initial.nextBefore)
  const loadingOlderRef = useRef(false)
  const sourceRef = useRef<EventSource | null>(null)

  // Bumped once per main-effect run (mount, then every workspace/filter switch). `loadOlder`
  // captures the value at dispatch and checks it before committing its completion — a filter
  // switch mid-flight bumps this, so a `loadOlder` started under the old filters can no longer
  // land in the new filters' buffer or cursor. A ref rather than an `AbortController` because the
  // races here are entirely in-process (state commits, not the network call itself): mirrors
  // `useWorkspaceStream`'s `refetchSeq` guard against the identical shape of race (a slow refetch
  // resolving after a newer one already landed).
  const generationRef = useRef(0)

  useEffect((): (() => void) => {
    generationRef.current += 1
    let cancelled = false

    const wireSource = (source: EventSource): void => {
      source.onopen = (): void => setConnection('connected')
      source.onerror = (): void => setConnection('reconnecting')
      source.onmessage = (message: { data: string }): void => {
        let event: ExecutionEvent
        try {
          event = JSON.parse(message.data) as ExecutionEvent
        } catch {
          return // not ours to crash over
        }
        if (event === null || typeof event !== 'object' || typeof event.seq !== 'number') return

        const row = rowFromEnvelope(event)
        setEvents((current) => appendRow(current, row))
        if (event.type === 'run.tool_call') {
          setSparkline((current) => {
            if (current.length === 0) return current
            const next = [...current]
            next[next.length - 1] = (next[next.length - 1] ?? 0) + 1
            return next
          })
        }
      }
    }

    const openStream = (fromSeq: number): void => {
      const source = new EventSource(streamUrl(workspaceId, filtersRef.current, fromSeq))
      wireSource(source)
      sourceRef.current = source
    }

    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      const ascending = [...initialRef.current.events].reverse()
      setEvents(ascending)
      setExhausted(false)
      nextBeforeRef.current = initialRef.current.nextBefore
      const newestSeq = ascending.at(-1)?.seq ?? 0
      openStream(newestSeq)
    } else {
      setEvents([])
      setExhausted(false)
      setError(null)
      void (async (): Promise<void> => {
        try {
          const response = await fetch(historyUrl(workspaceId, filtersRef.current))
          if (!response.ok) throw new Error(`activity history failed: ${response.status} ${await response.text()}`)
          const page = (await response.json()) as ActivityHistoryPage
          if (cancelled) return
          const ascending = [...page.events].reverse()
          setEvents(ascending)
          setExhausted(page.nextBefore === null)
          nextBeforeRef.current = page.nextBefore
          const newestSeq = ascending.at(-1)?.seq ?? 0
          openStream(newestSeq)
        } catch (cause) {
          if (cancelled) return
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })()
    }

    return (): void => {
      cancelled = true
      sourceRef.current?.close()
      sourceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters/initial arrive via refs.
  }, [workspaceId, filterKey])

  useEffect((): (() => void) => {
    const timer = setInterval((): void => {
      setSparkline((current) => (current.length === 0 ? current : [...current.slice(1), 0]))
    }, SPARKLINE_ROTATE_MS)
    return (): void => clearInterval(timer)
  }, [])

  const loadOlder = (): void => {
    if (loadingOlderRef.current || exhausted) return
    const oldestSeq = eventsRef.current[0]?.seq
    if (oldestSeq === undefined) return

    // Captured now: a filter/workspace switch that lands before this fetch resolves bumps
    // `generationRef.current` past this value, and the completion below must not commit stale
    // (old-filter) data over whatever the switch already loaded.
    const generation = generationRef.current
    loadingOlderRef.current = true
    setLoadingOlder(true)
    void (async (): Promise<void> => {
      try {
        const response = await fetch(historyUrl(workspaceId, filtersRef.current, { before: String(oldestSeq) }))
        if (!response.ok) throw new Error(`activity history failed: ${response.status} ${await response.text()}`)
        const page = (await response.json()) as ActivityHistoryPage
        if (generation !== generationRef.current) return // stale: filters/workspace changed mid-flight
        const ascendingOlder = [...page.events].reverse()
        setEvents((current) => [...ascendingOlder, ...current])
        setExhausted(page.nextBefore === null)
        nextBeforeRef.current = page.nextBefore
        setError(null)
      } catch (cause) {
        if (generation !== generationRef.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        // Always clears, even for a stale generation: this dispatch's own loading flag must not
        // outlive it, or a real subsequent `loadOlder()` call stays blocked forever.
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    })()
  }

  return { events, connection, loadOlder, loadingOlder, exhausted, sparkline, error }
}
