'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import type { AllSlavesPage, CatalogRowView, ProjectTeamRow, RosterCompany, RunbookRowView, WorkforceCatalogView } from '../../server/org'
import type { SlaveCardData } from '../../server/overview'
import type { PersonDetail, PersonRow } from '../../server/persons'
import type { EvidencePage } from '../../server/evidence'
import type { SkillsPage } from '../../server/skills'
import { CatalogImports, type CatalogImportRow } from '../CatalogImports'
import { CompanyManager, type CompanyRow } from '../CompanyManager'
import { DepartmentsTable } from '../DepartmentsTable'
import { SkillsClient } from '../SkillsClient'
import { SlavePanel } from '../SlavePanel'
import { PeopleTable } from '../persons/PeopleTable'
import { assignableProjectsOf } from '../persons/PersonProjectsGroup'
import { NewSlaveDrawer } from '../slaves/NewSlaveDrawer'
import { EvidenceTab } from './EvidenceTab'
import { RunbooksTab } from './RunbooksTab'
import { WorkforceCatalog } from './WorkforceCatalog'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { LoadingState } from '../ui/LoadingState'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { Segmented } from '../ui/Segmented'
import { Tabs } from '../ui/Tabs'

export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills' | 'runbooks' | 'evidence'

/** The FOUR visible tabs (M57 R13). `id` is still a `WorkforceTab`, so `Tabs`' own
 *  `workforce-tab-<id>` testids are byte-identical to the six-tab strip's first, third, fourth and
 *  sixth -- which is what lets `gate:m11-shell`, `gate:m14-fidelity` and `gate:m44-ux-foundation`
 *  carry over with no edit at all. Only the LABELS move. */
export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[] = [
  { id: 'slaves', label: 'People' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'skills', label: 'Skills & runbooks' },
  { id: 'evidence', label: 'Evidence' },
]

/**
 * The two tabs that folded, as SEGMENTS inside their new parent -- with their OWN testid namespace
 * (spec erratum E15).
 *
 * The draft of this plan kept `workforce-tab-<id>` on these, on the theory that a gate clicking
 * `workforce-tab-departments` would then keep working. It does not: `SUB_TABS.slaves` contains
 * `{id:'slaves'}` and `SUB_TABS.skills` contains `{id:'skills'}`, so on `?tab=slaves` the page
 * would render `workforce-tab-slaves` TWICE -- once as the visible People tab and once as the
 * segment -- which breaks this task's own four-tab assertion and puts `gate-m11-shell`'s
 * unqualified `getByTestId('workforce-tab-slaves')` into Playwright strict-mode failure.
 *
 * `workforce-segment-<id>` for all four. Every `?tab=` value still works, every bookmark still
 * lands, and the four gate/test hits on the two old names are re-pointed in this task.
 */
const SUB_TABS: Record<string, readonly { readonly id: WorkforceTab; readonly label: string }[]> = {
  slaves: [
    { id: 'slaves', label: 'Slaves' },
    { id: 'departments', label: 'Departments' },
  ],
  skills: [
    { id: 'skills', label: 'Skills' },
    { id: 'runbooks', label: 'Runbooks' },
  ],
}

/** `departments`/`runbooks` are `?tab=` values, never visible tabs -- the strip shows the PARENT
 *  they folded into, and the sub-segment row underneath (see `SUB_TABS`) is what actually names
 *  the folded surface. */
function visibleTabFor(tab: WorkforceTab): WorkforceTab {
  return tab === 'departments' ? 'slaves' : tab === 'runbooks' ? 'skills' : tab
}

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
  people,
  peopleDepartments,
  skillCatalogue,
  skillHolders,
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
  readonly people: readonly PersonRow[]
  readonly peopleDepartments: readonly { readonly companyTeamId: string; readonly name: string }[]
  readonly skillCatalogue: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  readonly skillHolders: Readonly<Record<string, readonly string[]>>
}): React.JSX.Element {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [tab, setTab] = useState<WorkforceTab>(initialTab)
  // A defensive backstop, not the fix for the segment's own click (that is `select` itself, called
  // directly from `Segmented`'s `onChange` -- ruling T8-2, fix round 1): re-syncs local state
  // whenever the SERVER hands this component a different `initialTab`, which happens after any
  // navigation this component did not itself drive -- the segment's `<Link>` pushing a history
  // entry a Back press later lands on, or a bookmark/external link arriving straight at a
  // `?tab=departments`/`?tab=runbooks` URL. `select()`'s own `replaceState` never changes what the
  // server rendered, so this effect stays a no-op re-set for every click that already went through
  // `select()`.
  useEffect((): void => {
    setTab(initialTab)
  }, [initialTab])
  const [newOpen, setNewOpen] = useState(false)
  const catalogPeople = useMemo(
    () => people.map((row) => ({ personId: row.personId, name: row.name })),
    [people],
  )
  const assignableProjects = useMemo(() => assignableProjectsOf(teams), [teams])
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null)
  const namedPerson = searchParams.get('slave')
  useEffect((): void => {
    if (namedPerson !== null && namedPerson !== '') setSelectedPerson(namedPerson)
  }, [namedPerson])
  const [personTick, setPersonTick] = useState(0)
  const [panel, setPanel] = useState<
    { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly person: PersonDetail }
  >({ kind: 'idle' })

  useEffect((): void => {
    if (selectedPerson === null) {
      setPanel({ kind: 'idle' })
      return
    }
    setPanel({ kind: 'loading' })
    void fetch(`/api/persons/${selectedPerson}`)
      .then(async (response) => (response.ok ? ((await response.json()) as PersonDetail) : null))
      .then((detail) => {
        setPanel(detail === null ? { kind: 'error' } : { kind: 'ready', person: detail })
      })
      .catch(() => setPanel({ kind: 'error' }))
  }, [selectedPerson, personTick])

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

  // Same MERGE rule `select` above uses (ruling R13): a segment's `href` carries whatever other
  // param the current URL already has, never a hard-coded `?tab=`.
  const hrefForTab = (next: WorkforceTab): string => {
    const query = new URLSearchParams(searchParams)
    query.set('tab', next)
    return `/workforce?${query.toString()}`
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
        <div className="flex flex-col gap-2">
          <Tabs
            tabs={WORKFORCE_TABS}
            current={visibleTabFor(tab)}
            ariaLabel="Workforce"
            testIdPrefix="workforce-tab"
            onSelect={(id) => select(id as WorkforceTab)}
          />
          {SUB_TABS[visibleTabFor(tab)] !== undefined && (
            // `ui/Segmented` (ruling T8-2, fix round 1) -- not a hand-rolled twin of it. `onChange`
            // is `select` itself: the SAME local-state update the main strip's `onSelect` makes,
            // so the segment's own `href` navigation is not the only thing that can move `tab` --
            // closing the dead-click race a navigation-only update left open.
            <Segmented
              options={(SUB_TABS[visibleTabFor(tab)] ?? []).map((sub) => ({ id: sub.id, label: sub.label, href: hrefForTab(sub.id) }))}
              value={tab}
              onChange={select}
              ariaLabel="Workforce sub-section"
              testIdPrefix="workforce-segment"
            />
          )}
        </div>
      }
    >
      {tab === 'slaves' && (
        <PeopleTable
          initial={people}
          departments={peopleDepartments}
          skills={skillCatalogue}
          skillHolders={skillHolders}
          onOpen={(personId) => setSelectedPerson(personId)}
        />
      )}
      {tab === 'departments' && <DepartmentsTable teams={teams} workspaces={workspaces} />}
      {tab === 'catalog' && (
        <div className="flex flex-col gap-4">
          <Panel title="Workforce catalog">
            <WorkforceCatalog initial={catalog} taxonomy={taxonomy} skillCatalogue={skillCatalogue} />
          </Panel>
          <Panel title="Companies">
            {/* M58 R5: a department holds PEOPLE, so the add-member form picks from everybody this
                installation has -- which is exactly what the Slaves tab's own rows already are.
                One row per SEAT, though (fix round 1, Minor 3), so a person sitting on two projects
                appears twice; the list is deduplicated by person or the select renders one React
                key twice and offers the same person as two choices. */}
            <CompanyManager companies={companies} roster={roster} people={catalogPeople} />
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
        roster={roster}
        templates={templates}
        teams={teams}
      />
      {panel.kind === 'loading' && <LoadingState testId="workforce-panel-loading" message="opening this slave…" />}
      {panel.kind === 'error' && (
        <Alert variant="error" testId="workforce-panel-error">
          could not open this slave — they may have been deleted. Try clicking the row again.
        </Alert>
      )}
      {panel.kind === 'ready' && (
        <div className="fixed inset-y-0 right-0 z-10 w-96 border-l border-line bg-panel shadow-resting motion-safe:animate-[panel-in_160ms_ease-out]">
          <SlavePanel
            key={panel.person.personId}
            slave={slaveCardForPerson(panel.person)}
            person={panel.person}
            projects={assignableProjects}
            skillCatalogue={skillCatalogue}
            liveEvents={[]}
            workspaceId={panel.person.seats[0]?.workspaceId ?? ''}
            haltedReason={null}
            onClose={() => setSelectedPerson(null)}
            onPersonChanged={() => setPersonTick((tick) => tick + 1)}
          />
        </div>
      )}
    </PageShell>
  )
}

function slaveCardForPerson(person: PersonDetail): SlaveCardData {
  const seat = person.seats[0]
  return {
    id: seat?.slaveId ?? person.personId,
    personId: person.personId,
    name: person.name,
    role: seat?.role ?? person.personaName ?? '',
    provider: person.provider?.value ?? null,
    gate: null,
    status: 'idle',
    taskTitle: null,
    taskId: null,
    taskStatus: null,
    progressPct: 0,
    stepLabel: null,
    skill: null,
    actionLine: null,
    runId: null,
    queuedMessage: null,
    resumeRequestedAt: null,
    recentEvents: [],
    costUsd: 0,
    toolCalls: 0,
    pausedAtStep: null,
    waitingFor: null,
    profile: person.profile,
    runtimeRoles: seat === undefined ? [] : [...seat.runtimeRoles],
    lifecycle: person.lifecycle,
    released: person.releasedAt === null ? null : { at: person.releasedAt, reason: person.releaseReason ?? '' },
    breakerLevel: 'none',
    permissions: [],
    permissionsRunKind: 'implementation',
  }
}
