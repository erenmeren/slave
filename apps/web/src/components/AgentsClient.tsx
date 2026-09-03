'use client'

import { useEffect, useState } from 'react'
import type { AgentStatus } from '@ai-team-os/domain'
import type { ProjectTeamRow, RosterCompany, WorkerRow } from '../server/org'
import type { AgentCardData, OverviewSnapshot } from '../server/overview'
import type { StatusTone } from './ui/StatusPill'
import { AgentPanel } from './AgentPanel'
import { RosterTable } from './RosterTable'
import { TeamsTable } from './TeamsTable'
import { WorkersTable } from './WorkersTable'

type Tab = 'roster' | 'workers' | 'teams'

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

/** Workers first, and first in the row: the design README's Agents page (§3a.2) IS the
 *  seven-column workers table. Roster stays a tab beside it (M14 fix wave, queue item (a)). */
const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'workers', label: 'Workers' },
  { id: 'roster', label: 'Roster' },
  { id: 'teams', label: 'Teams' },
]

/** The Agents page's tabbed root (M11 Task 8): local tab state, Roster (grouped company -> team,
 *  expandable member rows), Workers (a flat, self-polling table), and Teams (M23 D3: project
 *  team rename/delete, fed by `listProjectTeams()`) as the three panels. */
export function AgentsClient({
  roster,
  workers,
  teams,
}: {
  readonly roster: readonly RosterCompany[]
  readonly workers: readonly WorkerRow[]
  readonly teams: readonly ProjectTeamRow[]
}): React.JSX.Element {
  // `'workers'`, not `'roster'` (M14 fix wave, queue item (a) / review I3): the README specifies
  // the Agents page as the seven-column table, and the page opened on M11's roster instead. Landed
  // only after `listWorkers` stopped filtering to roster-linked agents (review I4) -- flipping the
  // default first would have opened the page on an empty header.
  const [tab, setTab] = useState<Tab>('workers')
  /**
   * Fix round 1 (Important finding): the CLICKED worker's own `agentId`/`workspaceId`, captured
   * at click time from `WorkersTable`'s `onOpen(worker)` -- never re-derived by looking `workers`
   * (this component's prop, the Agents page's one-time server snapshot) back up by id.
   * `WorkersTable` polls `/api/org/workers` every 5s and keeps the refreshed rows in its own
   * internal state, which never flows back into this prop; a worker materialized only after the
   * page's initial load has no entry in `workers` to find, and a lookup against it was a silent
   * no-op for exactly the row an operator can see and click.
   */
  const [selected, setSelected] = useState<{ readonly agentId: string; readonly workspaceId: string } | null>(null)
  const [panelAgent, setPanelAgent] = useState<AgentCardData | null>(null)

  useEffect((): void => {
    if (selected === null) {
      setPanelAgent(null)
      return
    }
    // The panel renders from the OVERVIEW snapshot of the agent's own workspace -- the one place
    // an `AgentCardData` is built. Fetching it here rather than widening `WorkerRow` into an
    // `AgentCardData` keeps one builder for that shape.
    void fetch(`/api/w/${selected.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelAgent(snapshot?.agents.find((a) => a.id === selected.agentId) ?? null))
      .catch(() => setPanelAgent(null))
  }, [selected])

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
      {tab === 'roster' ? (
        <RosterTable roster={roster} />
      ) : tab === 'teams' ? (
        <TeamsTable teams={teams} />
      ) : (
        <WorkersTable initial={workers} onOpen={(worker) => setSelected({ agentId: worker.agentId, workspaceId: worker.workspaceId })} />
      )}
      {panelAgent !== null && selected !== null && (
        <AgentPanel
          key={panelAgent.id}
          agent={panelAgent}
          liveEvents={[]}
          workspaceId={selected.workspaceId}
          haltedReason={null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
