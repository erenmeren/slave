'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { ShellFacts } from '../../server/shell'
import type { ProjectSettings } from '../../server/projectSettings'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { HaltBanner } from '../HaltBanner'
import { PermissionMatrix } from '../PermissionMatrix'
import { DangerConfirm } from '../ui/DangerConfirm'
import { PrimaryButton } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { GoalPanel } from './GoalPanel'
import { RuntimePanel } from './RuntimePanel'

/** The project Settings tab (M24 §4; M27 §3.4): goal, runtime, this project's permissions, and
 *  the danger zone -- the stop (hidden once the project is archived, since an archived project
 *  already runs nothing) plus archive/restore. Archiving POSTs `/api/w/:id/archive` and leaves
 *  the project (`router.push('/')` -- the archived project leaves this header's world, spec
 *  §3.3); restoring is reversible and has no confirm, so it just POSTs and refreshes in place. */
export function ProjectSettingsClient({
  settings,
  shellFacts,
}: {
  readonly settings: ProjectSettings
  readonly shellFacts: ShellFacts
}): React.JSX.Element {
  const { workspace, permissions, footprint } = settings
  const router = useRouter()
  const [restoreError, setRestoreError] = useState<string | null>(null)

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
    <div className="flex flex-col gap-4 p-4">
      {workspace.haltedReason !== null && <HaltBanner reason={workspace.haltedReason} />}
      <GoalPanel workspaceId={workspace.id} goal={workspace.goal} />
      <RuntimePanel
        key={`${workspace.provider ?? ''}|${workspace.budgetUsd ?? ''}`}
        workspaceId={workspace.id}
        provider={workspace.provider}
        budgetUsd={workspace.budgetUsd}
        costBlindBudgeted={workspace.costBlindBudgeted}
        limits={{ maxConcurrentRuns: workspace.maxConcurrentRuns, runTimeoutMs: workspace.runTimeoutMs, maxAttempts: workspace.maxAttempts }}
      />
      <Panel title="slave permissions">
        <PermissionMatrix sections={permissions === null ? [] : [permissions]} />
      </Panel>
      <Panel title="danger zone">
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
                <PrimaryButton data-testid="restore-project" onClick={() => void restore()}>
                  restore project
                </PrimaryButton>
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
      </Panel>
    </div>
  )
}
