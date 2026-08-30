'use client'

import { useEffect, useState } from 'react'
import type { AgentStatus } from '@ai-team-os/domain'
import type { RosterCompany, WorkerRow } from '../server/org'
import type { AgentCardData, OverviewSnapshot } from '../server/overview'
import type { StatusTone } from './ui/StatusPill'
import { AgentPanel } from './AgentPanel'
import { RosterTable } from './RosterTable'
import { WorkersTable } from './WorkersTable'

type Tab = 'roster' | 'workers'

/**
 * The M11 Task 8 status→tone mapping (controller ruling): every value `deriveAgentStatus`
 * (`packages/domain/src/agent/derived.ts`) can return, mapped onto the `ui/` tone vocabulary.
 * The ONE place this page derives a worker's `StatusPill` tone -- `RosterTable` and
 * `WorkersTable` both import `toneForStatus` below rather than re-deriving it. `satisfies`
 * keeps this exhaustive: a future `AgentStatus` member fails to compile here, not silently
 * falls through to a default tone at render time.
 */
export const AGENT_STATUS_TONE = {
  idle: 'idle',
  starting: 'planning',
  working: 'working',
  pausing: 'paused',
  paused: 'paused',
  resuming: 'planning',
  stopping: 'waiting',
} satisfies Record<AgentStatus, StatusTone>

/** `RosterMemberRow`/`WorkerRow` type a worker's `status` as a bare `string` (`server/org.ts`),
 *  even though it is always produced by `deriveAgentStatus` -- this looks it up defensively,
 *  falling back to `'idle'` for anything outside the known vocabulary rather than throwing. */
export function toneForStatus(status: string): StatusTone {
  return (AGENT_STATUS_TONE as Record<string, StatusTone>)[status] ?? 'idle'
}

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'roster', label: 'Roster' },
  { id: 'workers', label: 'Workers' },
]

/** The Agents page's tabbed root (M11 Task 8): local tab state, Roster (grouped company -> team,
 *  expandable member rows) and Workers (a flat, self-polling table) as the two panels. */
export function AgentsClient({
  roster,
  workers,
}: {
  readonly roster: readonly RosterCompany[]
  readonly workers: readonly WorkerRow[]
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('roster')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [panelAgent, setPanelAgent] = useState<AgentCardData | null>(null)
  const [panelWorkspaceId, setPanelWorkspaceId] = useState<string | null>(null)

  useEffect((): void => {
    if (selectedAgentId === null) {
      setPanelAgent(null)
      return
    }
    const worker = workers.find((w) => w.agentId === selectedAgentId)
    if (worker === undefined) return
    setPanelWorkspaceId(worker.workspaceId)
    // The panel renders from the OVERVIEW snapshot of the agent's own workspace -- the one place
    // an `AgentCardData` is built. Fetching it here rather than widening `WorkerRow` into an
    // `AgentCardData` keeps one builder for that shape.
    void fetch(`/api/w/${worker.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelAgent(snapshot?.agents.find((a) => a.id === selectedAgentId) ?? null))
      .catch(() => setPanelAgent(null))
  }, [selectedAgentId, workers])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div role="tablist" aria-label="Agents" className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`agents-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'roster' ? <RosterTable roster={roster} /> : <WorkersTable initial={workers} onOpen={setSelectedAgentId} />}
      {panelAgent !== null && panelWorkspaceId !== null && (
        <AgentPanel
          key={panelAgent.id}
          agent={panelAgent}
          liveEvents={[]}
          workspaceId={panelWorkspaceId}
          haltedReason={null}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  )
}
