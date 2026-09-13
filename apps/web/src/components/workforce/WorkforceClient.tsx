'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import type { AllSlavesPage, CatalogRowView, ProjectTeamRow, RosterCompany, RunbookRowView, WorkforceCatalogView } from '../../server/org'
import type { OverviewSnapshot, SlaveCardData } from '../../server/overview'
import type { EvidencePage } from '../../server/evidence'
import type { SkillsPage } from '../../server/skills'
import { AllSlavesTable } from '../AllSlavesTable'
import { CatalogImports, type CatalogImportRow } from '../CatalogImports'
import { CompanyManager, type CompanyRow } from '../CompanyManager'
import { DepartmentsTable } from '../DepartmentsTable'
import { SkillsClient } from '../SkillsClient'
import { SlavePanel } from '../SlavePanel'
import { NewSlaveDrawer } from '../slaves/NewSlaveDrawer'
import { EvidenceTab } from './EvidenceTab'
import { RunbooksTab } from './RunbooksTab'
import { WorkforceCatalog } from './WorkforceCatalog'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { LoadingState } from '../ui/LoadingState'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { Tabs } from '../ui/Tabs'

export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills' | 'runbooks' | 'evidence'

export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[] = [
  { id: 'slaves', label: 'Slaves' },
  { id: 'departments', label: 'Departments' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'skills', label: 'Skills' },
  // M48 R7: a runbook is a way of WORKING, which is what you look for after you know who is
  // here and what they are made of.
  { id: 'runbooks', label: 'Runbooks' },
  // M53 R12, LAST: a record is what you look at after you know who is here, what they are made of
  // and how they are asked to work. `docs/ia.md:41` and `:58` promised this since M44 -- the
  // per-profile evidence that replaces the Analytics tiles.
  { id: 'evidence', label: 'Evidence' },
]

/**
 * The Workforce page (M44 R1). Six tabs since M53 R12, and every panel on them is the one that was
 * already there: that milestone MOVED surfaces, it did not rewrite them (R5, and the roadmap's
 * "extend, do not rewrite"). What changed is where a person finds them -- four surfaces for "a
 * slave" used to be a sidebar row, another sidebar row, a section on the Projects home and a panel
 * inside a project; Runbooks, the fifth tab, is the way those people are asked to WORK; Evidence,
 * the sixth, is what their record actually says -- the per-profile and per-model tables that replace
 * the `/analytics` per-slave table and its raw `SUM(costUsd)` tile (M53 R12).
 *
 * The tab lives in `?tab=`, written with `window.history.replaceState` (fix round 1). It is the
 * SMALLER of the two options: `router.replace` on an `export const dynamic = 'force-dynamic'` page
 * re-runs all eleven of `workforce/page.tsx`'s loaders -- eleven reads, including `buildSkillsPage`'s
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
  catalog,
  catalogImports,
  skills,
  taxonomy,
  runbooks,
  evidence,
}: {
  readonly initialTab: WorkforceTab
  readonly slaves: AllSlavesPage
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly CatalogRowView[]
  readonly catalog: WorkforceCatalogView
  readonly catalogImports: readonly CatalogImportRow[]
  readonly skills: SkillsPage
  /** The capability taxonomy (M47 §2), read once by the page: what the catalog's profile drawer
   *  resolves a row's `capabilityKeys` into words with -- and, since M48, a runbook stage's own
   *  capabilities too. */
  readonly taxonomy: readonly CapabilityRecord[]
  /** Every runbook (M48 R7) -- read by the page beside the taxonomy that labels their stages. */
  readonly runbooks: readonly RunbookRowView[]
  /** The sixth tab's two tables (M53 R12), read on the SERVER under the `?domain=` the URL already
   *  claims to be filtering by -- both are `GROUP BY`s, and no amount of client work can narrow an
   *  aggregate that has already happened. */
  /** NULL when the page was not built for this tab (final wave): both of its aggregates are
   *  unindexed `GROUP BY`s over a table that grows by one row per run, so the server builds them
   *  only for `?tab=evidence`. Selecting the tab from another one asks the server again --
   *  {@link select} below -- which is the `EvidenceTab`'s own domain-chip idiom. */
  readonly evidence: EvidencePage | null
}): React.JSX.Element {
  const searchParams = useSearchParams()
  const router = useRouter()
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
  /**
   * THREE outcomes, not two (M44 final review, minor b). This was a single
   * `SlaveCardData | null`, which rendered the panel or rendered nothing -- and "nothing" was
   * both "the request is in flight" and "the request failed". An operator clicked a row and the
   * page did not move, and could not tell which of those had happened. `LoadingState` and `Alert`
   * are the two primitives R3 minted for exactly this pair of states.
   *
   * `error` also covers a 200 whose snapshot does not contain the slave: the row came from
   * `AllSlavesTable`'s own five-second poll, so a worker an operator can see and click may have
   * left its workspace's overview by the time this fetch answers. That is a failure to open the
   * panel, and it now says so instead of silently doing nothing.
   */
  const [panel, setPanel] = useState<
    { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly slave: SlaveCardData }
  >({ kind: 'idle' })

  useEffect((): void => {
    if (selected === null) {
      setPanel({ kind: 'idle' })
      return
    }
    setPanel({ kind: 'loading' })
    // The panel renders from the OVERVIEW snapshot of the slave's own workspace -- the one place
    // a `SlaveCardData` is built. Fetching it here rather than widening `AllSlaveRow` into an
    // `SlaveCardData` keeps one builder for that shape.
    void fetch(`/api/w/${selected.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => {
        const slave = snapshot?.slaves.find((a) => a.id === selected.slaveId) ?? null
        setPanel(slave === null ? { kind: 'error' } : { kind: 'ready', slave })
      })
      .catch(() => setPanel({ kind: 'error' }))
  }, [selected])

  const select = (next: WorkforceTab): void => {
    setTab(next)
    // MERGED into the current query, never a hard-coded `?tab=`: `ProjectsClient`'s ruling R13 --
    // replacing the URL wholesale would silently drop any other param a link arrived with.
    const query = new URLSearchParams(searchParams)
    query.set('tab', next)
    window.history.replaceState(null, '', `/workforce?${query.toString()}`)
    // ...and then, for the Evidence tab alone, ASK THE SERVER (final wave). Five of the six tabs
    // render from a prop this page was built with and a switch is local state; the sixth is two
    // grouped aggregates the page deliberately does not read unless the URL asks for them, so the
    // first switch onto it has nothing to render. `router.refresh()` after a `replaceState` is
    // exactly what `EvidenceTab`'s own domain chip does for the same reason -- Next re-reads the
    // query just written -- and it stacks no history entry. Once the page has the data, selecting
    // the tab again is local like the other five.
    if (next === 'evidence' && evidence === null) router.refresh()
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
          <Panel title="Workforce catalog">
            <WorkforceCatalog initial={catalog} taxonomy={taxonomy} />
          </Panel>
          <Panel title="Companies">
            <CompanyManager companies={companies} roster={roster} templates={templates} />
          </Panel>
          {/* M46 plan erratum E7: the import log is per-import-RUN, not per template, so it stays
              one panel on the tab instead of being repeated inside every profile drawer. It is
              under `Advanced` because "which import ran when" is a question you ask after
              something looks wrong, not while you are picking a specialist. */}
          <details data-testid="catalog-advanced">
            <summary className="cursor-pointer list-none text-xs text-text-3 hover:text-text-2">Advanced ▾</summary>
            <div className="pt-3">
              <Panel title="Catalog imports">
                <CatalogImports imports={catalogImports} />
              </Panel>
            </div>
          </details>
        </div>
      )}
      {tab === 'skills' && <SkillsClient page={skills} />}
      {tab === 'runbooks' && <RunbooksTab runbooks={runbooks} taxonomy={taxonomy} />}
      {tab === 'evidence' &&
        (evidence === null ? (
          // The server is being asked for it right now (see `select`). `LoadingState` and not an
          // empty table: "nothing has a record yet" is a claim this page cannot make while it is
          // still reading.
          <LoadingState testId="evidence-loading" message="Reading the record…" />
        ) : (
          <EvidenceTab page={evidence} />
        ))}
      <NewSlaveDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        companies={companies}
        roster={roster}
        templates={templates}
        workspaces={workspaces}
      />
      {panel.kind === 'loading' && <LoadingState testId="workforce-panel-loading" message="opening this slave…" />}
      {panel.kind === 'error' && (
        <Alert variant="error" testId="workforce-panel-error">
          could not open this slave — its project may have moved on. Try clicking the row again.
        </Alert>
      )}
      {panel.kind === 'ready' && selected !== null && (
        <SlavePanel
          key={panel.slave.id}
          slave={panel.slave}
          liveEvents={[]}
          workspaceId={selected.workspaceId}
          haltedReason={null}
          onClose={() => setSelected(null)}
        />
      )}
    </PageShell>
  )
}
