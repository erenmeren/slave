'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSelectedId } from '../hooks/useSelectedId'
import { useOverview } from '../hooks/useOverview'
import { announceProjectName } from '../hooks/useProjectName'
import type { OverviewSnapshot } from '../server/overview'
import { AgentCard } from './AgentCard'
import { AgentPanel } from './AgentPanel'
import { GoalCard } from './GoalCard'
import { RuntimeCard } from './RuntimeCard'
import { HaltBanner } from './HaltBanner'
import { ShellFactsProvider } from './ShellFactsContext'
import { TopBar } from './TopBar'
import { TopStrip } from './TopStrip'
import { Button } from './ui/Button'
import { Panel } from './ui/Panel'

/** Pulls a refusal's `{ error }` text, falling back to something nameable for any other non-2xx
 *  or malformed body — `AgentPanel.tsx`/`GoalCard.tsx`'s `errorMessage`, the house pattern here
 *  being a small local copy rather than a shared control-plane module. */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

async function postControl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { method: 'POST' })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * The "blocked · needs you" panel (design README §3a.1). `flex-1` beside the fixed 340px events
 * panel. Resume POSTs to the run route the card and the detail panel already use — no new
 * endpoint, and no second idea of what resume means.
 */
export function BlockedPanel({
  workspaceId,
  items,
}: {
  readonly workspaceId: string
  readonly items: OverviewSnapshot['blocked']
}): React.JSX.Element {
  const [errorText, setErrorText] = useState<string | null>(null)
  return (
    <div className="min-w-0 flex-1">
      <Panel title="blocked · needs you">
        {items.length === 0 ? (
          <p data-testid="blocked-empty" className="text-xs text-text-3">
            nothing needs you
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={`${item.kind}-${item.id}`} data-testid="blocked-row" className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-text-1">{item.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-text-3">{item.detail}</span>
                {item.action === 'resume' && item.runId !== null && (
                  <Button
                    variant="ghost"
                    data-testid="blocked-resume"
                    onClick={() => {
                      void postControl(`/api/w/${workspaceId}/runs/${item.runId}/resume`).then((result) => {
                        setErrorText(result.ok ? null : result.error)
                      })
                    }}
                  >
                    resume
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="blocked-error" className="text-xs text-status-danger">
            {errorText}
          </span>
        )}
      </Panel>
    </div>
  )
}

/**
 * The 340px live-events panel with the handoff's `all →` action (design README §3a.1).
 *
 * New rows rise (0.3s from `translateY(5px)`) — M11's deferred "new-row rise", landed here. A row
 * is "new" when its seq is above the highest this component had rendered before; a ref, not
 * state, because the class is decided at the row's own first render and no re-render is needed to
 * pick it up. The rows already on screen when the panel mounts do NOT animate: an arrival
 * animation on a list that was simply painted is motion that means nothing (spec §7).
 */
export function LiveEventsPanel({
  workspaceId,
  events,
}: {
  readonly workspaceId: string
  readonly events: OverviewSnapshot['liveEvents']
}): React.JSX.Element {
  const newest = events[0]?.seq ?? Number.NEGATIVE_INFINITY
  const highestSeenRef = useRef<number>(newest)
  const boundary = highestSeenRef.current
  if (newest > highestSeenRef.current) highestSeenRef.current = newest

  return (
    <div data-testid="live-events" className="w-[340px] shrink-0">
      <Panel title="live events" action={<Link href={`/w/${workspaceId}/activity`}>all →</Link>}>
        {events.length === 0 ? (
          <p data-testid="live-events-empty" className="text-xs text-text-3">
            no events yet
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event) => (
              <li
                key={event.seq}
                data-testid="live-event-row"
                className={`flex items-baseline gap-2 font-mono text-[10.5px] text-text-2 ${
                  event.seq > boundary ? 'motion-safe:animate-[rise_0.3s_ease-out]' : ''
                }`}
              >
                {/* `HH:MM:SS` out of the ISO stamp — the handoff's events panel is a mono time
                  * column, and the date is the same for every row a live panel ever shows. */}
                <span className="shrink-0 text-text-3">{event.ts.slice(11, 19)}</span>
                <span className="min-w-0 truncate">{event.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/**
 * The merge queue, serialized and FIFO (design README "Interactions & Behavior"). The order is
 * the daemon's own — see `server/overview.ts`'s `mergeQueue`, which reuses `merge.ts`'s
 * comparator rather than writing a second one.
 */
export function MergeQueuePanel({ queue }: { readonly queue: OverviewSnapshot['mergeQueue'] }): React.JSX.Element {
  return (
    <Panel title="merge queue · serial">
      {queue.length === 0 ? (
        <p data-testid="merge-empty" className="text-xs text-text-3">
          nothing in the queue
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {queue.map((task) => (
            <li key={task.id} data-testid="merge-row" className="flex items-center gap-2 text-xs text-text-1">
              <span className="min-w-0 truncate">{task.title}</span>
              {!task.hasApproval && (
                // The merge pass skips a `merging` task with no `task.review_approved` event, so
                // this one is not waiting its turn — it is stuck, and only the mark says so.
                <span
                  data-testid="merge-queue-no-approval"
                  className="shrink-0 rounded-chip border border-status-warn/40 px-1.5 py-0.5 font-mono text-[9.5px] text-status-warn"
                >
                  no approval
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

export function OverviewClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: OverviewSnapshot
}): React.JSX.Element {
  const { snapshot, actionLines, liveEvents, connection, error, latencyMs } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedAgentId, selectAgent] = useSelectedId('agent')
  const selectedAgent = view.agents.find((agent) => agent.id === selectedAgentId) ?? null

  // Fills the global shell's Sidebar project-section header with this workspace's real name
  // (M11 Task 10 ruling 2) — the root layout mounts one <Sidebar> with no per-route params of its
  // own, so this is how it learns the name rather than showing the bare workspaceId forever.
  useEffect((): void => {
    announceProjectName(workspaceId, view.workspace.name)
  }, [workspaceId, view.workspace.name])

  // Controller ruling carried from Task 3: the root layout's `<Sidebar>` opens its own
  // `EventSource` per workspace page. This page already streams the same workspace, and every
  // figure the sidebar shows is in the snapshot it is already holding — so it hands them down
  // and the sidebar opens nothing. `agentsWorking` is the same `status === 'working'` count the
  // strip's first tile shows, and `tasksActive` the same `tasks.active` its second one does; the
  // sidebar and the strip cannot disagree, because there is one number.
  const shellFacts = useMemo(
    () => ({
      facts: {
        workspace: { id: view.workspace.id, name: view.workspace.name },
        counts: {
          agentsWorking: view.agents.filter((a) => a.status === 'working').length,
          tasksActive: view.tasks.active,
        },
        guardrails: {
          budgetUsd: view.workspace.budgetUsd,
          maxConcurrentRuns: view.workspace.maxConcurrentRuns,
          runTimeoutMs: view.workspace.runTimeoutMs,
          maxAttempts: view.workspace.maxAttempts,
        },
      },
      latencyMs,
    }),
    [view, latencyMs],
  )

  return (
    <ShellFactsProvider value={shellFacts}>
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceId={workspaceId}
          workspaceName={view.workspace.name}
          connection={connection}
          latencyMs={latencyMs}
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
        <div className="grid grid-cols-1 gap-[11px] px-[20px] pt-[16px] md:grid-cols-2">
          <GoalCard workspaceId={workspaceId} goal={view.workspace.goal} suggestions={view.goalSuggestions} />
          <RuntimeCard
            workspaceId={workspaceId}
            provider={view.workspace.provider}
            budgetUsd={view.workspace.budgetUsd}
            costBlindBudgeted={view.workspace.costBlindBudgeted}
          />
        </div>
        {/* The handoff's 3-column card grid at an 11px gap (design README §3a.1), narrowing to
          * two and then one rather than shrinking the cards past the anatomy they hold. */}
        <main className="grid grid-cols-1 gap-[11px] px-[20px] pt-[16px] md:grid-cols-2 xl:grid-cols-3">
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
        {/* The bottom row: "blocked · needs you" takes the remaining width beside the fixed 340px
          * live-events panel, with the merge queue underneath. */}
        <div className="flex gap-[11px] px-[20px] pt-[16px]">
          <BlockedPanel workspaceId={workspaceId} items={view.blocked} />
          <LiveEventsPanel workspaceId={workspaceId} events={view.liveEvents} />
        </div>
        <div className="px-[20px] pb-[20px] pt-[11px]">
          <MergeQueuePanel queue={view.mergeQueue} />
        </div>
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
    </ShellFactsProvider>
  )
}
