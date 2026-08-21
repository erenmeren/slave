'use client'

import { useMemo, useState } from 'react'
import type { OverviewSnapshot } from '../server/overview.js'
import { useWorkspaceStream, type StreamEvent } from './useWorkspaceStream.js'

export { REFETCH_DEBOUNCE_MS } from './useWorkspaceStream.js'

export interface OverviewState {
  readonly snapshot: OverviewSnapshot | null
  /** Live action line per agent id — overlays snapshot.agents[].actionLine (spec §6). */
  readonly actionLines: Readonly<Record<string, string>>
  readonly connection: 'connected' | 'reconnecting'
  /** Set when the latest refetch failed; the UI dims and shows it (spec §9). */
  readonly error: string | null
}

/** A live line remembers which run produced it so a refetch can tell "still current" from "over". */
interface LiveLine {
  readonly runId: string | null
  readonly summary: string
}

/** Keep a line only while the snapshot still shows the run that produced it. */
function pruneLines(lines: Record<string, LiveLine>, agents: OverviewSnapshot['agents']): Record<string, LiveLine> {
  const runByAgent = new Map(agents.map((agent) => [agent.id, agent.runId]))
  const next: Record<string, LiveLine> = {}
  for (const [agentId, line] of Object.entries(lines)) {
    const runId = runByAgent.get(agentId) ?? null
    if (runId !== null && (line.runId === null || line.runId === runId)) next[agentId] = line
  }
  return next
}

export function useOverview(workspaceId: string, initial: OverviewSnapshot): OverviewState {
  const [lines, setLines] = useState<Record<string, LiveLine>>({})

  const { snapshot, connection, error } = useWorkspaceStream<OverviewSnapshot>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/overview`,
    initial,
    onEvent: (event: StreamEvent): void => {
      // The one exception to the wake-up rule: the action line is display-only ephemera and
      // paints immediately. Wrong is fine — the next refetch overwrites it; it is not state
      // (spec §6).
      if (event.type === 'run.tool_call' && typeof event.agentId === 'string') {
        const summary = event.payload?.summary
        if (typeof summary === 'string') {
          const runId = typeof event.runId === 'string' ? event.runId : null
          setLines((current) => ({ ...current, [event.agentId as string]: { runId, summary } }))
        }
      }
    },
    onSnapshot: (parsed: OverviewSnapshot): void => {
      // The live overlay always beats the snapshot's line (spec §6), so a refetch cannot
      // overwrite a stale one — it has to evict lines whose run the snapshot no longer shows.
      setLines((current) => pruneLines(current, parsed.agents))
    },
  })

  const actionLines = useMemo(
    () => Object.fromEntries(Object.entries(lines).map(([agentId, line]) => [agentId, line.summary])),
    [lines],
  )

  return { snapshot, actionLines, connection, error }
}
