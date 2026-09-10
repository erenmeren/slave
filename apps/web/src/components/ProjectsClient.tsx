'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SlaveStatus, UserWorkspaceState } from '@slave-of-ai/domain'
import { userWorkspaceStatus } from '@slave-of-ai/domain'
import { CARD_STATE_TONE, cardStateForSlave } from '../lib/tones'
import { sendControl } from '../lib/postControl'
import type { Kpi } from '../server/analytics'
import type { ProjectRow } from '../server/org'
import { AssignCompanyDialog } from './AssignCompanyDialog'
import { KpiStrip } from './analytics/KpiStrip'
import type { CompanyRow } from './CompanyManager'
import { NewProjectDrawer } from './projects/NewProjectDrawer'
import { AvatarTile } from './ui/AvatarTile'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Chip } from './ui/Chip'
import { Panel } from './ui/Panel'
import { ProgressBar } from './ui/ProgressBar'
import { PageShell } from './ui/PageShell'
import { SectionLabel } from './ui/SectionLabel'
import { StatStrip } from './ui/StatStrip'
import { StatusPill, type StatusTone } from './ui/StatusPill'

/**
 * A project's one word is `userWorkspaceStatus`'s now (M44 R4) -- the domain decides it, and this
 * file keeps only the half the domain may not have: the tone the pill is painted in (erratum E2,
 * `StatusTone` is an `apps/web` type). The old three-member table said "Halted / Running / Idle"
 * and could not say ARCHIVED or WAITING FOR YOU at all.
 */
const WORKSPACE_TONE: Record<UserWorkspaceState, StatusTone> = {
  archived: 'idle',
  halted: 'blocked',
  needs_you: 'waiting',
  working: 'working',
  idle: 'idle',
}

function ProjectCard({
  project,
  companies,
  assigning,
  onAssign,
  onCloseAssign,
}: {
  readonly project: ProjectRow
  readonly companies: readonly CompanyRow[]
  readonly assigning: boolean
  readonly onAssign: () => void
  readonly onCloseAssign: () => void
}): React.JSX.Element {
  const router = useRouter()
  const status = userWorkspaceStatus({
    archived: project.archived,
    halted: project.halted,
    needsYouCount: project.needsYou,
    tasksActive: project.taskCounts.active,
  })
  const tone = WORKSPACE_TONE[status.state]
  const pct = project.taskCounts.total > 0 ? Math.round((project.taskCounts.done / project.taskCounts.total) * 100) : 0
  const [restoreError, setRestoreError] = useState<string | null>(null)

  // Reversible (spec §3.4), so unlike archive there is no confirm here -- posting straight from
  // the click is the same idiom `AssignCompanyDialog` uses for its own single-POST control.
  const restore = async (): Promise<void> => {
    setRestoreError(null)
    const error = await sendControl(`/api/w/${project.id}/restore`, { method: 'POST' })
    if (error === null) router.refresh()
    else setRestoreError(error)
  }

  return (
    <div data-testid="project-card" className="flex flex-col gap-2">
      <Card onClick={() => router.push(`/w/${project.id}`)}>
        <div className="flex items-start gap-[9px]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[6px]">
              <span className="truncate text-[14px] font-semibold tracking-[-.2px]">{project.name}</span>
              <Chip>{project.companyName ?? 'no company'}</Chip>
              {project.archived && (
                <span data-testid="project-archived" className="rounded-pill border border-line px-[9px] py-[3px] text-[10px] text-text-faint">
                  archived
                </span>
              )}
            </div>
            <div data-testid="project-description" className="mt-[2px] truncate text-[11px] text-text-dim">
              {project.goal ?? 'no goal set'}
            </div>
            {/* The count behind the WAITING FOR YOU pill, said in words (M44 R1). A floor, never a
              * total -- `listProjects`' own doc comment and `docs/ia.md` both say what it counts
              * and what it does not. */}
            {project.needsYou > 0 && (
              <span data-testid="project-needs-you" className="mt-[2px] block text-[11px] text-tone-waiting">
                {project.needsYou} {project.needsYou === 1 ? 'thing needs' : 'things need'} you
              </span>
            )}
          </div>
          <StatusPill tone={tone} label={status.label} pulse={status.state === 'working'} />
        </div>

        <div aria-label="team" className="mt-[13px] flex flex-wrap items-center gap-1">
          {project.team.slice(0, 6).map((member) => (
            <AvatarTile
              key={member.slaveId}
              name={member.name}
              tone={CARD_STATE_TONE[cardStateForSlave(member.status as SlaveStatus)].tone}
            />
          ))}
          {project.team.length > 6 && (
            <span
              data-testid="team-overflow"
              title={project.team.slice(6).map((member) => member.name).join(', ')}
              className="flex h-[28px] w-[28px] items-center justify-center rounded-tile border border-line bg-bg-2 font-mono text-[10px] text-text-2"
            >
              +{project.team.length - 6}
            </span>
          )}
        </div>

        <div className="mt-[14px]">
          <ProgressBar pct={pct} tone={tone} />
        </div>
        <div className="mt-[5px] flex justify-between font-mono text-[10px] text-text-3">
          <span>progress</span>
          <span>{pct}%</span>
        </div>

        <div className="mt-[14px]">
          {/* The caveat rides INSIDE the spend tile, as `StatStripItem.note` (M14 fix wave, queue
            * item (f)) -- exactly where `TopStrip` nests its own `strip-unmeasured`. It is never
            * folded into the figure (Decision 4), and the strip stays exactly 4-up, which is the
            * handoff's own geometry -- except an archived project (M27 §3.4's "no spend bar"),
            * which drops to 3-up: spend is a live-budget figure, and an archived project spends
            * nothing more. `slaves`/`active`/`blocked` stay -- they are still this project's
            * history, which an archived project keeps in full (spec §3.3). */}
          <StatStrip
            items={[
              { label: 'slaves', value: String(project.workerCount) },
              { label: 'active', value: String(project.taskCounts.active), ...(project.taskCounts.active > 0 ? { tone: 'working' as const } : {}) },
              { label: 'blocked', value: String(project.taskCounts.blocked), ...(project.taskCounts.blocked > 0 ? { tone: 'blocked' as const } : {}) },
              ...(project.archived
                ? []
                : [
                    {
                      label: 'spend',
                      value: `$${project.spend.toFixed(2)}`,
                      ...(project.unmeasuredRuns > 0
                        ? {
                            note: (
                              <span data-testid="project-unmeasured" className="font-mono text-[9.5px] text-tone-waiting">
                                {project.unmeasuredRuns} run{project.unmeasuredRuns === 1 ? '' : 's'} unmeasured
                              </span>
                            ),
                          }
                        : {}),
                    },
                  ]),
            ]}
          />
        </div>
      </Card>
      {project.archived ? (
        <div className="flex flex-col gap-1">
          <Button variant="primary" size="sm" data-testid="restore-project" className="w-full" onClick={(event) => { event.stopPropagation(); void restore() }}>
            restore
          </Button>
          {restoreError !== null && (
            <span role="alert" data-testid="restore-project-error" className="text-xs text-tone-blocked">
              {restoreError}
            </span>
          )}
        </div>
      ) : (
        <>
          {project.companyName === null && (
            // M44 R3: the wrapper `<div>` this button sat in existed only to give the dialog a ref
            // to return focus to. `Button` forwards a ref now, and `ui/Dialog` reads the opener off
            // `document.activeElement` anyway, so both are gone.
            <Button
              variant="ghost"
              className="w-full"
              data-testid="assign-company-button"
              onClick={(event) => {
                event.stopPropagation()
                onAssign()
              }}
            >
              Assign company
            </Button>
          )}
          {assigning && (
            <AssignCompanyDialog workspaceId={project.id} companies={companies} onClose={onCloseAssign} />
          )}
        </>
      )}
    </div>
  )
}

/**
 * The Projects page's root (M24 §5.2): the "New project" button opens the attach-a-repo drawer
 * (`NewProjectDrawer`, `?new=1` opens it on load -- the project header's switcher's last row
 * links there), the project cards grid stays as it was, and the team catalog -- the template
 * catalog and the company manager, moved down from Settings by Task 5 -- sits below it.
 * `templates`/`roster` feed that catalog and are required, the same as `companies` was on
 * `SettingsClient` before Task 5 moved it here -- a caller with no data still passes `[]`
 * explicitly rather than the catalog silently going empty.
 *
 * M27 §3.4: `show archived` round-trips through `?archived=1` (`page.tsx` reads the same param to
 * decide whether `listProjects` includes archived rows at all) rather than filtering `projects`
 * client-side -- an archived project's card needs the server's archived-row fields anyway, and
 * there is no reason to fetch a row this page would only throw away. The checkbox sits grouped
 * with the New project button at the row's right end (the header's own `ml-auto flex ... gap-3`
 * idiom, `project/ProjectHeader.tsx`) with the button LAST in that group, so the button keeps the
 * exact position it already had -- the M14 fidelity gate screenshots this row, and a checkbox
 * placed after the button would shift it.
 *
 * Toggling it MERGES into the current query rather than replacing the URL wholesale (controller
 * ruling R13, fix round 1): it builds `new URLSearchParams(searchParams)`, sets or deletes just
 * `archived`, and keeps every other param (`?new=1`, say) intact -- a hard-coded `'/?archived=1'`
 * would have clobbered them.
 */
export function ProjectsClient({
  projects,
  companies,
  kpis,
}: {
  readonly projects: readonly ProjectRow[]
  readonly companies: readonly CompanyRow[]
  /**
   * The ALL-workspaces KPI tiles (M44 R1), from the same `buildAnalytics` `/analytics` calls with a
   * null scope. Just the tiles, not the whole `AnalyticsSnapshot` (fix round 1): this is a CLIENT
   * component, so every field handed to it is serialized into the RSC payload and shipped to the
   * browser -- `series` and `perSlave` would have crossed the wire on every Projects load for a
   * section that renders neither. Required, not optional: a caller with nothing to show passes
   * `[]` rather than the section silently disappearing.
   */
  readonly kpis: readonly Kpi[]
}): React.JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [assigningWorkspaceId, setAssigningWorkspaceId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(searchParams.get('new') === '1')
  const showArchived = searchParams.get('archived') === '1'

  return (
    // M44 erratum E25 / M45 R5: the shell WRAPS this page's own frame rather than replacing it --
    // `flush` drops the shell's `gap-4 p-3 md:p-4`, so the page keeps its own padding, gap and
    // width exactly and not a pixel moves. The shell is here for its landmark and its
    // `page-shell` marker.
    <PageShell flush>
      <div className="flex flex-col">
        <div className="flex items-center justify-between px-[20px] pt-[18px]">
          <SectionLabel>Projects</SectionLabel>
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-[6px] text-xs text-text-2">
              <input
                type="checkbox"
                data-testid="show-archived"
                checked={showArchived}
                onChange={(event) => {
                  const query = new URLSearchParams(searchParams)
                  if (event.target.checked) query.set('archived', '1')
                  else query.delete('archived')
                  const search = query.toString()
                  router.replace(search === '' ? '/' : `/?${search}`)
                }}
              />
              show archived
            </label>
            <Button variant="primary" size="sm" data-testid="new-project" onClick={() => setNewOpen(true)}>
              + New project
            </Button>
          </span>
        </div>
        <div className="grid grid-cols-1 gap-[14px] p-[18px_20px] md:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              companies={companies}
              assigning={assigningWorkspaceId === project.id}
              onAssign={() => setAssigningWorkspaceId(project.id)}
              onCloseAssign={() => setAssigningWorkspaceId(null)}
            />
          ))}
        </div>
        {/* M44 R1/E20: the ONE section here that is not about a single project. The team catalog
          * that used to sit in this slot moved to Workforce -> Catalog; Analytics left the sidebar
          * and its all-workspaces view arrived here instead, because a spend figure is a fact about
          * the projects above it and belongs where somebody can act on it. `/analytics` keeps its
          * route, its `?workspace=` scope and this link (`docs/ia.md`). */}
        <section data-testid="all-projects-analytics" className="flex flex-col gap-4 px-[20px] pb-[20px]">
          <Panel
            title="across every project"
            action={
              <Link href="/analytics" className="text-[10px] text-text-3 hover:text-text-1">
                all →
              </Link>
            }
          >
            <KpiStrip kpis={kpis} />
          </Panel>
        </section>
        <NewProjectDrawer
          open={newOpen}
          onClose={() => {
            setNewOpen(false)
            // Ruled minor (M24 final review): `?new=1` opened this drawer on load -- closing it
            // without dropping the param left it in the URL to reopen the drawer on the next
            // reload, even after the operator dismissed it on purpose. Dropped by MERGING into the
            // current query (R13's rule, the same as `show archived` above): a bare `'/'` would
            // also throw away `?archived=1`.
            if (searchParams.get('new') === '1') {
              const query = new URLSearchParams(searchParams)
              query.delete('new')
              const search = query.toString()
              router.replace(search === '' ? '/' : `/?${search}`)
            }
          }}
        />
      </div>
    </PageShell>
  )
}
