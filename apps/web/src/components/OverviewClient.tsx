'use client'

import { useSelectedId } from '../hooks/useSelectedId'
import { useOverview } from '../hooks/useOverview'
import type { OverviewSnapshot } from '../server/overview'
import { AgentCard } from './AgentCard'
import { AgentPanel } from './AgentPanel'
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
  const { snapshot, actionLines, liveEvents, connection, error } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedAgentId, selectAgent] = useSelectedId('agent')
  const selectedAgent = view.agents.find((agent) => agent.id === selectedAgentId) ?? null

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
            <AgentCard key={agent.id} agent={agent} liveActionLine={actionLines[agent.id] ?? null} onOpen={selectAgent} />
          ))}
        </main>
      </div>
      {selectedAgent !== null && (
        <AgentPanel
          agent={selectedAgent}
          liveEvents={liveEvents[selectedAgent.id] ?? []}
          workspaceId={workspaceId}
          haltedReason={view.workspace.haltedReason}
          onClose={() => selectAgent(null)}
        />
      )}
    </div>
  )
}
