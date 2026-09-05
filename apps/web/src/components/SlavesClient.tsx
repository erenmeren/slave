'use client'

import { useEffect, useState } from 'react'
import type { SlaveStatus } from '@slave-of-ai/domain'
import type { AllSlavesPage, ProjectTeamRow, RosterCompany } from '../server/org'
import type { SlaveCardData, OverviewSnapshot } from '../server/overview'
import type { StatusTone } from './ui/StatusPill'
import { SlavePanel } from './SlavePanel'
import { NewSlaveDrawer } from './slaves/NewSlaveDrawer'
import { AllSlavesTable } from './AllSlavesTable'
import { DepartmentsTable } from './DepartmentsTable'
import type { TemplateRow } from './TemplateCatalog'
import { PrimaryButton } from './ui/FormControls'

type Tab = 'slaves' | 'departments'

/**
 * The M11 Task 8 status→tone mapping (controller ruling): every value `deriveSlaveStatus`
 * (`packages/domain/src/slave/derived.ts`) can return, mapped onto the `ui/` tone vocabulary.
 * The ONE place this page derives a worker's `StatusPill` tone -- `AllSlavesTable` imports
 * `toneForStatus` below rather than re-deriving it. `satisfies` keeps this exhaustive: a future
 * `SlaveStatus` member fails to compile here, not silently falls through to a default tone at
 * render time.
 */
export const SLAVE_STATUS_TONE = {
  idle: 'idle',
  starting: 'planning',
  working: 'working',
  pausing: 'paused',
  paused: 'paused',
  resuming: 'planning',
  stopping: 'waiting',
} satisfies Record<SlaveStatus, StatusTone>

/** `AllSlaveRow` types a row's `status` as a bare `string` (`server/org.ts`), even though it is
 *  always produced by `deriveSlaveStatus` -- this looks it up defensively, falling back to
 *  `'idle'` for anything outside the known vocabulary rather than throwing. */
export function toneForStatus(status: string): StatusTone {
  return (SLAVE_STATUS_TONE as Record<string, StatusTone>)[status] ?? 'idle'
}

/** The Slaves page's two tabs (M24 §5.3, Task 7; renamed in M25 §4.2 Task 7): Slaves, the one
 *  table (every project slave plus every catalog member no project has materialized yet), and
 *  Departments (M23 D3: project team rename/delete plus a "New department" form, fed by
 *  `listProjectTeams()`/`listWorkspaceNames()`). Roster and Workers were two names for the same
 *  list of slaves and are gone. */
const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'slaves', label: 'Slaves' },
  { id: 'departments', label: 'Departments' },
]

/** The Slaves page's tabbed root (M11 Task 8; folded to two tabs in M24 Task 7; Departments tab
 *  in M25 Task 7; `+ New slave` in M25 Task 8): local tab state, Slaves (the one table, default)
 *  and Departments as the two panels, with a header row carrying the tablist and the `+ New
 *  slave` button that opens `NewSlaveDrawer` -- the catalog form. */
export function SlavesClient({
  slaves,
  teams,
  workspaces,
  companies,
  roster,
  templates,
}: {
  readonly slaves: AllSlavesPage
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { id: string; name: string }[]
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('slaves')
  const [newOpen, setNewOpen] = useState(false)
  /**
   * Fix round 1 (Important finding): the CLICKED slave's own `slaveId`/`workspaceId`, captured
   * at click time from `AllSlavesTable`'s `onOpen(row)` -- never re-derived by looking `slaves`
   * (this component's prop, the Slaves page's one-time server snapshot) back up by id.
   * `AllSlavesTable` polls `/api/org/workers` every 5s and keeps the refreshed rows in its own
   * internal state, which never flows back into this prop -- `slaves` stays exactly what the page
   * rendered on load even after a poll adds a brand-new row or drops a deleted one (M24 final
   * review, Important 4). A row an operator can see and click may therefore have no entry in
   * `slaves` at all; a lookup against it was, and remains, the wrong source for its identity.
   */
  const [selected, setSelected] = useState<{ readonly slaveId: string; readonly workspaceId: string } | null>(null)
  const [panelSlave, setPanelSlave] = useState<SlaveCardData | null>(null)

  useEffect((): void => {
    if (selected === null) {
      setPanelSlave(null)
      return
    }
    // The panel renders from the OVERVIEW snapshot of the slave's own workspace -- the one place
    // an `SlaveCardData` is built. Fetching it here rather than widening `AllSlaveRow` into an
    // `SlaveCardData` keeps one builder for that shape.
    void fetch(`/api/w/${selected.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelSlave(snapshot?.slaves.find((a) => a.id === selected.slaveId) ?? null))
      .catch(() => setPanelSlave(null))
  }, [selected])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div role="tablist" aria-label="Slaves" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`slaves-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <PrimaryButton data-testid="new-slave" onClick={() => setNewOpen(true)}>
          + New slave
        </PrimaryButton>
      </div>
      {tab === 'departments' ? (
        <DepartmentsTable teams={teams} workspaces={workspaces} />
      ) : (
        <AllSlavesTable initial={slaves} onOpen={(row) => setSelected(row)} />
      )}
      {panelSlave !== null && selected !== null && (
        <SlavePanel
          key={panelSlave.id}
          slave={panelSlave}
          liveEvents={[]}
          workspaceId={selected.workspaceId}
          haltedReason={null}
          onClose={() => setSelected(null)}
        />
      )}
      <NewSlaveDrawer
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
