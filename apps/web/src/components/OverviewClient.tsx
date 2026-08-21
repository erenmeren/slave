'use client'

import { useOverview } from '../hooks/useOverview'
import type { OverviewSnapshot } from '../server/overview'
import { AgentCard } from './AgentCard'
import { HaltBanner } from './HaltBanner'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { TopStrip } from './TopStrip'

export function OverviewClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: OverviewSnapshot
}): React.JSX.Element {
  const { snapshot, actionLines, connection, error } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar workspaceId={workspaceId} />
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceName={view.workspace.name}
          connection={connection}
          budget={{ spentUsd: view.workspace.spentUsd, budgetUsd: view.workspace.budgetUsd }}
        />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <TopStrip snapshot={view} />
        <main className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {view.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} liveActionLine={actionLines[agent.id] ?? null} />
          ))}
        </main>
      </div>
    </div>
  )
}
