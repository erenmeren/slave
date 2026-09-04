'use client'

import type { ProjectSettings } from '../../server/projectSettings'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { PermissionMatrix } from '../PermissionMatrix'
import { Panel } from '../ui/Panel'
import { GoalPanel } from './GoalPanel'
import { RuntimePanel } from './RuntimePanel'

/** The project Settings tab (M24 §4): goal, runtime, this project's permissions, the stop. */
export function ProjectSettingsClient({ settings }: { readonly settings: ProjectSettings }): React.JSX.Element {
  const { workspace, permissions } = settings
  return (
    <div className="flex flex-col gap-4 p-4">
      <GoalPanel workspaceId={workspace.id} goal={workspace.goal} />
      <RuntimePanel
        key={`${workspace.provider ?? ''}|${workspace.budgetUsd ?? ''}`}
        workspaceId={workspace.id}
        provider={workspace.provider}
        budgetUsd={workspace.budgetUsd}
        costBlindBudgeted={workspace.costBlindBudgeted}
        limits={{ maxConcurrentRuns: workspace.maxConcurrentRuns, runTimeoutMs: workspace.runTimeoutMs, maxAttempts: workspace.maxAttempts }}
      />
      <Panel title="agent permissions">
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
