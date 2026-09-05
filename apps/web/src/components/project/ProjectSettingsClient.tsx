'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { ShellFacts } from '../../server/shell'
import type { ProjectSettings } from '../../server/projectSettings'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { HaltBanner } from '../HaltBanner'
import { PermissionMatrix } from '../PermissionMatrix'
import { Panel } from '../ui/Panel'
import { GoalPanel } from './GoalPanel'
import { RuntimePanel } from './RuntimePanel'

/** The project Settings tab (M24 §4): goal, runtime, this project's permissions, the stop. */
export function ProjectSettingsClient({
  settings,
  shellFacts,
}: {
  readonly settings: ProjectSettings
  readonly shellFacts: ShellFacts
}): React.JSX.Element {
  const { workspace, permissions } = settings

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
        <div className="flex items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
          <span className="text-xs text-text-2">stop every run in this project</span>
          <span className="ml-auto">
            <EmergencyStopButton workspaceId={workspace.id} halted={workspace.haltedReason !== null} />
          </span>
        </div>
      </Panel>
    </div>
  )
}
