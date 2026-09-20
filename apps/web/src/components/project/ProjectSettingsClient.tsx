'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { ShellFacts } from '../../server/shell'
import type { ProjectSettings } from '../../server/projectSettings'
import type { RunbookPanelView } from '../../server/runbook'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { HaltBanner } from '../HaltBanner'
import { PermissionMatrix } from '../PermissionMatrix'
import { DangerConfirm } from '../ui/DangerConfirm'
import { PageShell } from '../ui/PageShell'
import { SettingsFrame } from '../ui/SettingsFrame'
import { GoalPanel } from './GoalPanel'
import { RunbookPanel } from './RunbookPanel'
import { RuntimePanel } from './RuntimePanel'
import { Button } from '../ui/Button'

/** The project Settings tab's five sections (M61 R12/R13, Task 9). Order is the nav order --
 *  Goal, Runbook, Runtime, Permissions, Danger zone, the same order the plan brief states it in. */
export const PROJECT_SETTINGS_SECTIONS = [
  { id: 'goal', label: 'Goal' },
  { id: 'runbook', label: 'Runbook' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'danger', label: 'Danger zone' },
] as const

export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number]['id']

function isProjectSettingsSection(value: string | null | undefined): value is ProjectSettingsSection {
  return PROJECT_SETTINGS_SECTIONS.some((section) => section.id === value)
}

/**
 * The project Settings tab (M24 §4; M27 §3.4): goal, runtime, this project's permissions, and
 * the danger zone -- the stop (hidden once the project is archived, since an archived project
 * already runs nothing) plus archive/restore. Archiving POSTs `/api/w/:id/archive` and leaves
 * the project (`router.push('/')` -- the archived project leaves this header's world, spec
 * §3.3); restoring is reversible and has no confirm, so it just POSTs and refreshes in place.
 *
 * M61 R7/Task 6 adds the Runbook section -- moved off the deleted Overview, `RunbookPanel` and its
 * eleven testids unchanged. `GoalHistory` is not a section of its own (spec erratum E1): `GoalPanel`
 * already renders it, folded, the moment a goal exists, so it needs no second mount here.
 *
 * M61 R12/Task 9: the sticky in-page anchor nav is `SettingsFrame` now -- the same two-column
 * `180px minmax(0,760px)` split the README always called for, but `?section=` picks the section
 * instead of a scroll position, and only the chosen one mounts (`data-testid="settings-<id>"`,
 * the same convention the global Settings page uses).
 */
export function ProjectSettingsClient({
  settings,
  shellFacts,
  // Optional, defaulting to `null` (RunbookPanel's own "nothing to say" case) rather than
  // required: `test/project-settings.test.tsx`'s existing cases render this component for its
  // goal/runtime/permissions/danger behaviour and know nothing about runbooks, and a required prop
  // would fail every one of them on a change this task did not ask them to make.
  runbook = null,
  initialSection,
}: {
  readonly settings: ProjectSettings
  readonly shellFacts: ShellFacts
  readonly runbook?: RunbookPanelView | null
  /** `?section=`, read on the SERVER (`app/w/[workspaceId]/settings/page.tsx`) -- an unknown or
   *  absent value falls back to the first section, the same way `SettingsClient`'s own
   *  `initialSection` does. */
  readonly initialSection?: string | undefined
}): React.JSX.Element {
  const { workspace, permissions, footprint } = settings
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [section, setSection] = useState<ProjectSettingsSection>(
    isProjectSettingsSection(initialSection) ? initialSection : PROJECT_SETTINGS_SECTIONS[0].id,
  )
  useEffect((): void => {
    if (isProjectSettingsSection(initialSection)) setSection(initialSection)
  }, [initialSection])

  const onSelect = (id: string): void => {
    if (!isProjectSettingsSection(id)) return
    setSection(id)
    const query = new URLSearchParams(searchParams.toString())
    query.set('section', id)
    router.replace(`${pathname}?${query.toString()}`, { scroll: false })
  }

  const restore = async (): Promise<void> => {
    setRestoreError(null)
    const error = await sendControl(`/api/w/${workspace.id}/restore`, { method: 'POST' })
    if (error === null) router.refresh()
    else setRestoreError(error)
  }

  // This tab streams nothing of its own (every form below calls `router.refresh()` after a
  // write), but the project header and tab strip still need this workspace's figures while this
  // tab is the one mounted -- so it publishes the page's own snapshot to
  // `hooks/useShellFacts.ts`, exactly as `TasksClient.tsx`/`OverviewClient.tsx` do with theirs.
  useEffect((): void => {
    publishShellFacts(workspace.id, shellFacts)
  }, [workspace.id, shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup above
  // would retract and re-publish on every `router.refresh()`, flashing the header to its fallback
  // facts between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspace.id, null), [workspace.id])

  return (
    // M44 erratum E25 / M45 R5: the shell WRAPS this page's own frame rather than replacing it --
    // `flush` drops the shell's `gap-4 p-3 md:p-4` so the page keeps its own padding and gap
    // exactly, and not a pixel moves. The shell is here for its landmark and its `page-shell`
    // marker.
    <PageShell flush>
      {workspace.haltedReason !== null && <HaltBanner reason={workspace.haltedReason} />}
      <SettingsFrame sections={PROJECT_SETTINGS_SECTIONS} current={section} onSelect={onSelect}>
        <div className="flex flex-col gap-5">
          {/* M57 t8 fix round 1, ruling T8-5: GoalPanel/RuntimePanel already render their own
            * `ui/Panel` card -- a bare wrapper here, no card recipe of its own, so the section is
            * one card, not two nested ones. Mounted on demand now (Task 9): `data-testid`, not
            * `id` -- there is no anchor to jump to any more, `?section=` picks the section. */}
          {section === 'goal' && (
            <section data-testid="settings-goal">
              <GoalPanel
                workspaceId={workspace.id}
                goal={workspace.goal}
                goalVersion={workspace.goalVersion}
                // The re-plan trigger's own question (`dispatchPlanning` check 2): every task the
                // project has, terminal ones included, which is exactly what `projectFootprint`
                // counts.
                boardTaskCount={footprint.tasks}
                // `tick` returns before `dispatchPlanning` while a halt stands, so the re-plan
                // sentence must not be said on a halted project. Off the same field the halt
                // banner above reads.
                halted={workspace.haltedReason !== null}
              />
            </section>
          )}
          {/* M61 R7/Task 6: moved off the deleted Overview, between who is doing it (Team, now the
            * project's own page) and what happened (Activity) -- the same relative position the
            * README always gave it. `RunbookPanel` draws its own `runbook-panel` div and `Panel`
            * card, so this section is a bare wrapper, exactly like `settings-goal`/
            * `settings-runtime`. */}
          {section === 'runbook' && (
            <section data-testid="settings-runbook">
              <RunbookPanel workspaceId={workspace.id} view={runbook} />
            </section>
          )}
          {section === 'runtime' && (
            <section data-testid="settings-runtime">
              <RuntimePanel
                key={`${workspace.provider ?? ''}|${workspace.budgetUsd ?? ''}`}
                workspaceId={workspace.id}
                provider={workspace.provider}
                budgetUsd={workspace.budgetUsd}
                costBlindBudgeted={workspace.costBlindBudgeted}
                limits={{ maxConcurrentRuns: workspace.maxConcurrentRuns, runTimeoutMs: workspace.runTimeoutMs, maxAttempts: workspace.maxAttempts }}
              />
            </section>
          )}
          {/* Permissions and Danger have no inner `Panel` of their own to double up with, so THEY
            * keep the section's own card recipe -- an `<h2>` (Settings' Appearance section's own
            * heading recipe) replaces the `Panel title=…` that used to draw both the card AND the
            * heading. Every `perm-*` testid `PermissionMatrix` renders is untouched. */}
          {section === 'permissions' && (
            <section data-testid="settings-permissions" className="flex flex-col gap-3 rounded-page-card border border-line bg-card p-[18px_20px]">
              <h2 className="m-0 text-[15px] font-semibold text-t1">Permissions</h2>
              <PermissionMatrix sections={permissions === null ? [] : [permissions]} />
            </section>
          )}
          {section === 'danger' && (
            <section
              data-testid="settings-danger"
              className="flex flex-col gap-3 rounded-page-card border border-[color-mix(in_oklab,var(--s-blocked)_40%,var(--line))] bg-card p-[18px_20px]"
            >
              <h2 className="m-0 text-[15px] font-semibold text-t1">Danger zone</h2>
              <div className="flex flex-col gap-3">
                {!workspace.archived && (
                  <div className="flex items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
                    <span className="text-xs text-text-2">stop every run in this project</span>
                    <span className="ml-auto">
                      <EmergencyStopButton workspaceId={workspace.id} halted={workspace.haltedReason !== null} />
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
                  <span className="text-xs text-text-2">
                    {workspace.archived ? 'restore this project to active use' : 'archive this project'}
                  </span>
                  <span className="ml-auto flex flex-col items-end gap-1">
                    {workspace.archived ? (
                      <Button variant="primary" size="sm" data-testid="restore-project" onClick={() => void restore()}>
                        restore project
                      </Button>
                    ) : (
                      <DangerConfirm
                        label="archive project"
                        testId="archive-project"
                        confirmText={
                          `archives ${workspace.name}: ${plural(footprint.departments, 'department')}, ${plural(footprint.slaves, 'slave')}, ` +
                          `${plural(footprint.tasks, 'task')}, ${plural(footprint.runs, 'run')} stay on record; nothing runs until you restore it`
                        }
                        onConfirm={async () => {
                          const error = await sendControl(`/api/w/${workspace.id}/archive`, { method: 'POST' })
                          if (error === null) router.push('/')
                          return error
                        }}
                      />
                    )}
                    {restoreError !== null && (
                      <span role="alert" data-testid="restore-project-error" className="text-xs text-tone-blocked">
                        {restoreError}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </section>
          )}
        </div>
      </SettingsFrame>
    </PageShell>
  )
}
