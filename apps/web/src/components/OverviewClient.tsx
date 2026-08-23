'use client'

import { useSelectedId } from '../hooks/useSelectedId'
import { useOverview } from '../hooks/useOverview'
import type { OverviewSnapshot } from '../server/overview'
import { AgentCard } from './AgentCard'
import { AgentPanel } from './AgentPanel'
import { GoalCard } from './GoalCard'
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
          workspaceId={workspaceId}
          workspaceName={view.workspace.name}
          connection={connection}
          budget={{ spentUsd: view.workspace.spentUsd, budgetUsd: view.workspace.budgetUsd }}
          halted={view.workspace.haltedReason !== null}
        />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <TopStrip snapshot={view} />
        <div className="px-4 pt-4">
          <GoalCard workspaceId={workspaceId} goal={view.workspace.goal} />
        </div>
        <main className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {view.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} liveActionLine={actionLines[agent.id] ?? null} onOpen={selectAgent} />
          ))}
        </main>
      </div>
      {selectedAgent !== null && (
        <AgentPanel
          // Keyed on the agent id so switching `?agent=` unmounts the old panel instance instead
          // of reusing it with new props: a control POST still in flight for the agent just
          // switched away from must not paint its late error/pending state onto the next agent's
          // panel — React drops a state update against an unmounted component instead of
          // delivering it (fix round 2, Finding 2).
          key={selectedAgent.id}
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
