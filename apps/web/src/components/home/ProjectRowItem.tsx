'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { userWorkspaceStatus } from '@slave-of-ai/domain'
import { formatUsd } from '../../lib/realMoney'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import type { ProjectRow } from '../../server/org'
import { AssignCompanyDialog } from '../AssignCompanyDialog'
import type { CompanyRow } from '../CompanyManager'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { useModalDismiss } from '../ui/useModalDismiss'

/**
 * One row of Home's project list (M61 R11, Task 8). A `<Link>` for the WHOLE row (Resolutions:
 * the row navigates to `/w/<id>` on any click that is not the trailing `⋯`), with the menu button
 * a SIBLING absolutely positioned over its right edge rather than nested inside the anchor -- a
 * `<button>` inside an `<a>` is invalid HTML, the same rule `ProjectsClient.tsx`'s old card
 * (`restore-project`/`assign-company-button` sitting OUTSIDE the clickable `Card`) already
 * followed.
 *
 * The status word comes from `userWorkspaceStatus` (the domain's own projection), never a bare
 * `project.archived`/`halted` check restated here -- `docs/ia.md` rule 3: a label, never a key.
 */
export function ProjectRowItem({
  project,
  companies,
}: {
  readonly project: ProjectRow
  readonly companies: readonly CompanyRow[]
}): React.JSX.Element {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const menuRef = useModalDismiss<HTMLDivElement>({ open: menuOpen, onClose: () => setMenuOpen(false) })

  const status = userWorkspaceStatus({
    archived: project.archived,
    halted: project.halted,
    needsYouCount: project.needsYou,
    tasksActive: project.taskCounts.active,
  })
  const pct = project.taskCounts.total > 0 ? Math.round((project.taskCounts.done / project.taskCounts.total) * 100) : 0

  const restore = async (): Promise<void> => {
    setRestoreError(null)
    const error = await sendControl(`/api/w/${project.id}/restore`, { method: 'POST' })
    if (error === null) {
      setMenuOpen(false)
      router.refresh()
    } else {
      setRestoreError(error)
    }
  }

  return (
    <div className="relative">
      <Link
        data-testid="project-row"
        data-workspace={project.id}
        data-status={status.state}
        data-needs-you={project.needsYou}
        // M61 Task 8 review, Ruling 8: `gate-m16-chrome.mjs` check 3's independent-Prisma-count
        // oracle now reads this bare attribute instead of counting avatar tiles/an overflow pill
        // that no longer exist on this row -- same fact (`server/org.ts`'s `ProjectRow.workerCount`).
        data-team-size={project.workerCount}
        // M11's own rule, restored in M61 Task 11: a project row says which COMPANY staffs it, and
        // says "no company" before one is assigned. The deleted `ProjectsClient` card carried it
        // as plain text under the name; nothing carried it after that card went, and
        // `gate-m11-shell.mjs`'s own badge assertion is what found the hole. The attribute is the
        // raw value beside the word (`docs/ia.md` rule 3).
        data-company={project.companyName ?? ''}
        href={`/w/${project.id}`}
        className="grid h-[var(--row-h)] grid-cols-[minmax(0,1fr)_150px_90px_80px] items-center gap-3 rounded-control px-2.5 pr-9 hover:bg-hover"
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-t1">{project.name}</span>
          {project.archived && (
            <Chip testId="project-archived" tone="idle">
              archived
            </Chip>
          )}
          <Chip testId="project-company" tone="idle">
            {project.companyName ?? 'no company'}
          </Chip>
          <span className="type-meta min-w-0 flex-1 truncate text-t2">{project.goal ?? 'no goal set'}</span>
        </div>
        <div className={`type-meta truncate ${project.needsYou > 0 ? 'font-medium text-accent' : 'text-t2'}`}>
          {status.label}
          {/* An invariant adjective, never `plural(n, 'working')` (M61 Task 8 review, item 2) --
            * "working" describes the STATE these tasks are in, not a countable noun that takes an
            * `s`; `OfficeHud.tsx`'s own `${view.working} working` is the same idiom. */}
          {project.taskCounts.active > 0 && ` · ${project.taskCounts.active} working`}
        </div>
        <div className="type-meta text-t2">{project.archived ? '' : formatUsd(project.spend)}</div>
        <div className="type-meta text-t2">{pct}%</div>
      </Link>

      <button
        type="button"
        data-testid="project-menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${project.name} menu`}
        onClick={() => setMenuOpen((was) => !was)}
        className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-control text-t3 hover:bg-hover hover:text-t1"
      >
        ⋯
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="project-menu-popover"
          tabIndex={-1}
          className="glass absolute right-1 top-full z-20 mt-1 flex w-[220px] flex-col gap-1 rounded-surface border border-line p-1 shadow-resting"
        >
          {!project.archived && project.companyName === null && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="assign-company-button"
              className="justify-start"
              onClick={() => {
                setMenuOpen(false)
                setAssigning(true)
              }}
            >
              Assign company
            </Button>
          )}
          {project.archived ? (
            <div className="flex flex-col gap-1 px-1">
              <Button variant="primary" size="sm" data-testid="restore-project" onClick={() => void restore()}>
                Restore
              </Button>
              {restoreError !== null && (
                <span role="alert" data-testid="restore-project-error" className="text-xs text-tone-blocked">
                  {restoreError}
                </span>
              )}
            </div>
          ) : (
            <div className="px-1">
              <DangerConfirm
                label="Archive"
                testId="archive-project"
                className="w-full justify-start"
                confirmText={`archives ${project.name}: ${plural(project.workerCount, 'slave')}, ${plural(project.taskCounts.total, 'task')} stay on record`}
                onConfirm={async () => {
                  const error = await sendControl(`/api/w/${project.id}/archive`, { method: 'POST' })
                  // `router.refresh()` only, no `setMenuOpen(false)` here: `DangerConfirm` itself
                  // is what is running this callback, and closing ITS OWN parent (the popover)
                  // before it finishes collapsing back to the trigger would unmount the component
                  // mid-callback. The refresh replaces `project.archived` on this same row (React
                  // reconciles by `project.id`, so `menuOpen` survives it), which is what actually
                  // needs to change.
                  if (error === null) router.refresh()
                  return error
                }}
              />
            </div>
          )}
          <Link
            data-testid="project-menu-settings"
            href={`/w/${project.id}/settings`}
            onClick={() => setMenuOpen(false)}
            className="type-meta rounded-control px-2 py-1.5 text-t2 hover:bg-hover hover:text-t1"
          >
            Settings
          </Link>
        </div>
      )}

      {assigning && (
        <AssignCompanyDialog workspaceId={project.id} companies={companies} onClose={() => setAssigning(false)} />
      )}
    </div>
  )
}
