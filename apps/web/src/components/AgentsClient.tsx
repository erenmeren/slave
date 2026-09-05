'use client'

import { useEffect, useState } from 'react'
import type { AgentStatus } from '@slave-of-ai/domain'
import type { AllAgentsPage, ProjectTeamRow, RosterCompany } from '../server/org'
import type { AgentCardData, OverviewSnapshot } from '../server/overview'
import type { StatusTone } from './ui/StatusPill'
import { AgentPanel } from './AgentPanel'
import { NewAgentDrawer } from './agents/NewAgentDrawer'
import { AllAgentsTable } from './AllAgentsTable'
import { DepartmentsTable } from './DepartmentsTable'
import type { TemplateRow } from './TemplateCatalog'
import { PrimaryButton } from './ui/FormControls'

type Tab = 'agents' | 'departments'

/**
 * The M11 Task 8 status→tone mapping (controller ruling): every value `deriveAgentStatus`
 * (`packages/domain/src/agent/derived.ts`) can return, mapped onto the `ui/` tone vocabulary.
 * The ONE place this page derives a worker's `StatusPill` tone -- `AllAgentsTable` imports
 * `toneForStatus` below rather than re-deriving it. `satisfies` keeps this exhaustive: a future
 * `AgentStatus` member fails to compile here, not silently falls through to a default tone at
 * render time.
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

/** `AllAgentRow` types a row's `status` as a bare `string` (`server/org.ts`), even though it is
 *  always produced by `deriveAgentStatus` -- this looks it up defensively, falling back to
 *  `'idle'` for anything outside the known vocabulary rather than throwing. */
export function toneForStatus(status: string): StatusTone {
  return (AGENT_STATUS_TONE as Record<string, StatusTone>)[status] ?? 'idle'
}

/** The Agents page's two tabs (M24 §5.3, Task 7; renamed in M25 §4.2 Task 7): Agents, the one
 *  table (every project agent plus every catalog member no project has materialized yet), and
 *  Departments (M23 D3: project team rename/delete plus a "New department" form, fed by
 *  `listProjectTeams()`/`listWorkspaceNames()`). Roster and Workers were two names for the same
 *  list of agents and are gone. */
const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'departments', label: 'Departments' },
]

/** The Agents page's tabbed root (M11 Task 8; folded to two tabs in M24 Task 7; Departments tab
 *  in M25 Task 7; `+ New agent` in M25 Task 8): local tab state, Agents (the one table, default)
 *  and Departments as the two panels, with a header row carrying the tablist and the `+ New
 *  agent` button that opens `NewAgentDrawer` -- the catalog form. */
export function AgentsClient({
  agents,
  teams,
  workspaces,
  companies,
  roster,
  templates,
}: {
  readonly agents: AllAgentsPage
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { id: string; name: string }[]
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('agents')
  const [newOpen, setNewOpen] = useState(false)
  /**
   * Fix round 1 (Important finding): the CLICKED agent's own `agentId`/`workspaceId`, captured
   * at click time from `AllAgentsTable`'s `onOpen(row)` -- never re-derived by looking `agents`
   * (this component's prop, the Agents page's one-time server snapshot) back up by id.
   * `AllAgentsTable` polls `/api/org/workers` every 5s and keeps the refreshed rows in its own
   * internal state, which never flows back into this prop -- `agents` stays exactly what the page
   * rendered on load even after a poll adds a brand-new row or drops a deleted one (M24 final
   * review, Important 4). A row an operator can see and click may therefore have no entry in
   * `agents` at all; a lookup against it was, and remains, the wrong source for its identity.
   */
  const [selected, setSelected] = useState<{ readonly agentId: string; readonly workspaceId: string } | null>(null)
  const [panelAgent, setPanelAgent] = useState<AgentCardData | null>(null)

  useEffect((): void => {
    if (selected === null) {
      setPanelAgent(null)
      return
    }
    // The panel renders from the OVERVIEW snapshot of the agent's own workspace -- the one place
    // an `AgentCardData` is built. Fetching it here rather than widening `AllAgentRow` into an
    // `AgentCardData` keeps one builder for that shape.
    void fetch(`/api/w/${selected.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelAgent(snapshot?.agents.find((a) => a.id === selected.agentId) ?? null))
      .catch(() => setPanelAgent(null))
  }, [selected])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
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
        <PrimaryButton data-testid="new-agent" onClick={() => setNewOpen(true)}>
          + New agent
        </PrimaryButton>
      </div>
      {tab === 'departments' ? (
        <DepartmentsTable teams={teams} workspaces={workspaces} />
      ) : (
        <AllAgentsTable initial={agents} onOpen={(row) => setSelected(row)} />
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
      <NewAgentDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        companies={companies}
        roster={roster}
        templates={templates}
        workspaces={workspaces}
      />
    </div>
  )
}
