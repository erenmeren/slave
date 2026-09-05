'use client'

import { useMemo, useState } from 'react'
// Runtime import, not `../server/overview.js`: that module pulls in `@slave-of-ai/db`'s prisma
// client, which must never reach the client bundle (controller ruling R3).
import { feedSummary, type SlaveFeedEvent } from '../lib/feedSummary'
import type { OverviewSnapshot } from '../server/overview'
import { useWorkspaceStream, type StreamEvent } from './useWorkspaceStream'

export { REFETCH_DEBOUNCE_MS } from './useWorkspaceStream'

/** The slave detail panel's rolling live feed keeps at most this many events per slave. */
const LIVE_EVENTS_LIMIT = 50

export interface OverviewState {
  readonly snapshot: OverviewSnapshot | null
  /** Live action line per slave id — overlays snapshot.slaves[].actionLine (spec §6). */
  readonly actionLines: Readonly<Record<string, string>>
  /** Rolling live feed per slave id (cap 50) — the panel merges this with the snapshot's seed
   *  `recentEvents` (spec §6). Display-only ephemera, like the action line: never pruned by a
   *  refetch, only ever grown by the stream. */
  readonly liveEvents: Readonly<Record<string, readonly SlaveFeedEvent[]>>
  readonly connection: 'connected' | 'reconnecting'
  /** Set when the latest refetch failed; the UI dims and shows it (spec §9). */
  readonly error: string | null
  /** Passed straight through from `useWorkspaceStream` (M14 §3) — the top bar's `sse · <ms>`
   *  chip. `null` until the first event with a parseable `ts` arrives. */
  readonly latencyMs: number | null
}

/** A live line remembers which run produced it so a refetch can tell "still current" from "over". */
interface LiveLine {
  readonly runId: string | null
  readonly summary: string
}

/** Keep a line only while the snapshot still shows the run that produced it. */
function pruneLines(lines: Record<string, LiveLine>, slaves: OverviewSnapshot['slaves']): Record<string, LiveLine> {
  const runBySlave = new Map(slaves.map((slave) => [slave.id, slave.runId]))
  const next: Record<string, LiveLine> = {}
  for (const [slaveId, line] of Object.entries(lines)) {
    const runId = runBySlave.get(slaveId) ?? null
    if (runId !== null && (line.runId === null || line.runId === runId)) next[slaveId] = line
  }
  return next
}

export function useOverview(workspaceId: string, initial: OverviewSnapshot): OverviewState {
  const [lines, setLines] = useState<Record<string, LiveLine>>({})
  const [liveEvents, setLiveEvents] = useState<Record<string, readonly SlaveFeedEvent[]>>({})

  const { snapshot, connection, error, latencyMs } = useWorkspaceStream<OverviewSnapshot>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/overview`,
    initial,
    onEvent: (event: StreamEvent): void => {
      // The one exception to the wake-up rule: the action line is display-only ephemera and
      // paints immediately. Wrong is fine — the next refetch overwrites it; it is not state
      // (spec §6).
      if (event.type === 'run.tool_call' && typeof event.slaveId === 'string') {
        const summary = event.payload?.summary
        if (typeof summary === 'string') {
          const runId = typeof event.runId === 'string' ? event.runId : null
          setLines((current) => ({ ...current, [event.slaveId as string]: { runId, summary } }))
        }
      }

      // The slave panel's live feed: every recognized, slave-scoped event, not just tool calls
      // (spec §6 — the feed shows the run's whole story, the action line only its latest step).
      if (typeof event.slaveId === 'string' && typeof event.type === 'string' && typeof event.seq === 'number') {
        const slaveId = event.slaveId
        const feedEvent: SlaveFeedEvent = {
          seq: event.seq,
          ts: typeof event.ts === 'string' ? event.ts : '',
          type: event.type,
          summary: feedSummary(event.type, event.payload ?? {}),
        }
        setLiveEvents((current) => {
          const existing = current[slaveId] ?? []
          const next = [...existing, feedEvent].slice(-LIVE_EVENTS_LIMIT)
          return { ...current, [slaveId]: next }
        })
      }
    },
    onSnapshot: (parsed: OverviewSnapshot): void => {
      // The live overlay always beats the snapshot's line (spec §6), so a refetch cannot
      // overwrite a stale one — it has to evict lines whose run the snapshot no longer shows.
      setLines((current) => pruneLines(current, parsed.slaves))
    },
  })

  const actionLines = useMemo(
    () => Object.fromEntries(Object.entries(lines).map(([slaveId, line]) => [slaveId, line.summary])),
    [lines],
  )

  return { snapshot, actionLines, liveEvents, connection, error, latencyMs }
}
