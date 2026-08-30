'use client'

import { useEffect } from 'react'
import { useSelectedId } from '../hooks/useSelectedId'
import { useOverview } from '../hooks/useOverview'
import { announceProjectName } from '../hooks/useProjectName'
import type { OverviewSnapshot } from '../server/overview'
import { AgentCard } from './AgentCard'
import { AgentPanel } from './AgentPanel'
import { GoalCard } from './GoalCard'
import { RuntimeCard } from './RuntimeCard'
import { HaltBanner } from './HaltBanner'
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

  // Fills the global shell's Sidebar project-section header with this workspace's real name
  // (M11 Task 10 ruling 2) — the root layout mounts one <Sidebar> with no per-route params of its
  // own, so this is how it learns the name rather than showing the bare workspaceId forever.
  useEffect((): void => {
    announceProjectName(workspaceId, view.workspace.name)
  }, [workspaceId, view.workspace.name])

  return (
    <>
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceId={workspaceId}
          workspaceName={view.workspace.name}
          connection={connection}
          budget={{
            spentUsd: view.workspace.spentUsd,
            budgetUsd: view.workspace.budgetUsd,
            unmeasuredRuns: view.workspace.unmeasuredRuns,
          }}
          halted={view.workspace.haltedReason !== null}
        />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <TopStrip snapshot={view} />
        <div className="grid grid-cols-1 gap-4 px-4 pt-4 md:grid-cols-2">
          <GoalCard workspaceId={workspaceId} goal={view.workspace.goal} />
          <RuntimeCard
            workspaceId={workspaceId}
            provider={view.workspace.provider}
            budgetUsd={view.workspace.budgetUsd}
            costBlindBudgeted={view.workspace.costBlindBudgeted}
          />
        </div>
        <main className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {view.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              liveActionLine={actionLines[agent.id] ?? null}
              workspaceId={workspaceId}
              onOpen={selectAgent}
            />
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
    </>
  )
}
