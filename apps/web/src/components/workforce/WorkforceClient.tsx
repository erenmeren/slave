'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { AllSlavesPage, ProjectTeamRow, RosterCompany } from '../../server/org'
import type { OverviewSnapshot, SlaveCardData } from '../../server/overview'
import type { SkillsPage } from '../../server/skills'
import { AllSlavesTable } from '../AllSlavesTable'
import { CatalogImports, type CatalogImportRow } from '../CatalogImports'
import { CompanyManager, type CompanyRow } from '../CompanyManager'
import { DepartmentsTable } from '../DepartmentsTable'
import { SkillsClient } from '../SkillsClient'
import { SlavePanel } from '../SlavePanel'
import { TemplateCatalog, type TemplateRow } from '../TemplateCatalog'
import { NewSlaveDrawer } from '../slaves/NewSlaveDrawer'
import { Button } from '../ui/Button'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { Tabs } from '../ui/Tabs'

export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills'

export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[] = [
  { id: 'slaves', label: 'Slaves' },
  { id: 'departments', label: 'Departments' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'skills', label: 'Skills' },
]

/**
 * The Workforce page (M44 R1). Four tabs, and every panel on them is the one that was already
 * there: this milestone MOVES surfaces, it does not rewrite them (R5, and the roadmap's "extend,
 * do not rewrite"). What changed is where a person finds them -- four surfaces for "a slave" used
 * to be a sidebar row, another sidebar row, a section on the Projects home and a panel inside a
 * project.
 *
 * The tab lives in `?tab=`, written with `window.history.replaceState` (fix round 1). It is the
 * SMALLER of the two options: `router.replace` on an `export const dynamic = 'force-dynamic'` page
 * re-runs all eight of `workforce/page.tsx`'s loaders -- eight queries, including `buildSkillsPage`'s
 * disk scan -- to re-render a page whose data did not change and whose panel switch this component
 * already made in local state. `replaceState` writes the URL and nothing else, so a reload or a
 * shared link still lands on the tab, which is the whole contract. Neither stacks a history entry
 * a Back press has to walk through.
 */
export function WorkforceClient({
  initialTab,
  slaves,
  teams,
  workspaces,
  companies,
  roster,
  templates,
  catalogImports,
  skills,
}: {
  readonly initialTab: WorkforceTab
  readonly slaves: AllSlavesPage
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
  readonly catalogImports: readonly CatalogImportRow[]
  readonly skills: SkillsPage
}): React.JSX.Element {
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<WorkforceTab>(initialTab)
  const [newOpen, setNewOpen] = useState(false)
  /**
   * MOVED verbatim from `SlavesClient` (deleted this task), including its fix-round-1 rule: the
   * CLICKED slave's own `slaveId`/`workspaceId`, captured at click time from `AllSlavesTable`'s
   * `onOpen(row)` -- never re-derived by looking the id back up in `slaves`, this page's one-time
   * server snapshot. `AllSlavesTable` polls `/api/org/workers` every 5s into its own state, which
   * never flows back into that prop, so a row an operator can see and click may have no entry in
   * `slaves` at all.
   */
  const [selected, setSelected] = useState<{ readonly slaveId: string; readonly workspaceId: string } | null>(null)
  const [panelSlave, setPanelSlave] = useState<SlaveCardData | null>(null)

  useEffect((): void => {
    if (selected === null) {
      setPanelSlave(null)
      return
    }
    // The panel renders from the OVERVIEW snapshot of the slave's own workspace -- the one place
    // a `SlaveCardData` is built. Fetching it here rather than widening `AllSlaveRow` into an
    // `SlaveCardData` keeps one builder for that shape.
    void fetch(`/api/w/${selected.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelSlave(snapshot?.slaves.find((a) => a.id === selected.slaveId) ?? null))
      .catch(() => setPanelSlave(null))
  }, [selected])

  const select = (next: WorkforceTab): void => {
    setTab(next)
    // MERGED into the current query, never a hard-coded `?tab=`: `ProjectsClient`'s ruling R13 --
    // replacing the URL wholesale would silently drop any other param a link arrived with.
    const query = new URLSearchParams(searchParams)
    query.set('tab', next)
    window.history.replaceState(null, '', `/workforce?${query.toString()}`)
  }

  return (
    <PageShell
      title="Workforce"
      testId="workforce"
      action={
        tab === 'slaves' ? (
          <Button variant="primary" data-testid="new-slave" onClick={() => setNewOpen(true)}>
            + New slave
          </Button>
        ) : undefined
      }
      tabs={
        <Tabs
          tabs={WORKFORCE_TABS}
          current={tab}
          ariaLabel="Workforce"
          testIdPrefix="workforce-tab"
          onSelect={(id) => select(id as WorkforceTab)}
        />
      }
    >
      {tab === 'slaves' && <AllSlavesTable initial={slaves} onOpen={(row) => setSelected(row)} />}
      {tab === 'departments' && <DepartmentsTable teams={teams} workspaces={workspaces} />}
      {tab === 'catalog' && (
        <div className="flex flex-col gap-4">
          <Panel title="Template catalog">
            <TemplateCatalog templates={templates} />
          </Panel>
          <Panel title="Companies">
            <CompanyManager companies={companies} roster={roster} templates={templates} />
          </Panel>
          <Panel title="Catalog imports">
            <CatalogImports imports={catalogImports} />
          </Panel>
        </div>
      )}
      {tab === 'skills' && <SkillsClient page={skills} />}
      <NewSlaveDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        companies={companies}
        roster={roster}
        templates={templates}
        workspaces={workspaces}
      />
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
    </PageShell>
  )
}
