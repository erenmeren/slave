'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useActivityStream } from '../../hooks/useActivityStream'
import { useUrlFilters } from '../../hooks/useUrlFilters'
import type { ActivityPage } from '../../server/activity'
import { Sidebar } from '../Sidebar'
import { Sparkline } from '../Sparkline'
import { TopBar } from '../TopBar'
import { FilterBar } from './FilterBar'
import { Timeline, type TimelineHandle } from './Timeline'

/**
 * The activity page's client shell: Sidebar + TopBar (workspace name is static from the initial
 * server snapshot — only `connection` is live, same as `TasksClient`) + `FilterBar` + a header
 * `Sparkline` (Task 9) fed the hook's live-rotated `sparkline` + the virtualized `Timeline`.
 *
 * Live-follow etiquette: `pinned` starts `true` (a freshly loaded page is scrolled to the newest
 * event) and flips on `Timeline`'s `onPinnedChange` report of the viewport's own scroll position.
 * While pinned, every newly arrived event scrolls the viewport to the bottom, so the "N new
 * events" badge never has anything to accumulate. Once unpinned, arriving events instead bump
 * `pendingCount`; clicking the badge scrolls to the bottom, clears the count, and re-pins.
 */
export function ActivityClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: ActivityPage
}): React.JSX.Element {
  const { filters, kinds, rawTypes, setKinds, setRawTypes, setAgents, setTasks } = useUrlFilters()
  const { events, connection, loadOlder, sparkline } = useActivityStream({ workspaceId, filters, initial })

  const agentNameById = useMemo(() => new Map(initial.agents.map((agent) => [agent.id, agent.name])), [initial.agents])
  const taskTitleById = useMemo(() => new Map(initial.tasks.map((task) => [task.id, task.title])), [initial.tasks])

  const [pinned, setPinned] = useState(true)
  const [pendingCount, setPendingCount] = useState(0)
  const timelineRef = useRef<TimelineHandle>(null)
  // The newest `seq` already accounted for by the follow logic below — seeded from the initial
  // page so the mount render itself never reads as "new events arrived". A raw event-count delta
  // (the previous approach) double-counts two things that grow `events.length` without anything
  // new having arrived: `loadOlder`'s prepended history (older rows land at the FRONT) and a
  // filter/workspace switch's freshly reloaded page (the buffer empties, then repopulates with a
  // page that isn't itself new either) — review finding Critical 1. Comparing by `seq` instead of
  // by length sidesteps both: a prepend never raises the newest `seq`, and the reset is detected
  // by the buffer passing through empty, which re-seeds the baseline instead of scoring the
  // reload as arrivals.
  const lastAccountedSeqRef = useRef<number | null>(events.at(-1)?.seq ?? null)

  useEffect((): void => {
    const newestSeq = events.at(-1)?.seq ?? null

    if (newestSeq === null) {
      // The buffer is momentarily empty — either nothing has arrived yet, or a filter/workspace
      // switch just cleared it mid-reload. Either way there is nothing to compare against, so the
      // baseline clears too: the page this reload lands is a fresh baseline next, not "new
      // events".
      lastAccountedSeqRef.current = null
      return
    }

    const baseline = lastAccountedSeqRef.current
    lastAccountedSeqRef.current = newestSeq
    if (baseline === null || newestSeq <= baseline) return // first load, a post-reset reload, or a `loadOlder` prepend

    let addedCount = 0
    for (let i = events.length - 1; i >= 0 && (events[i]?.seq ?? -Infinity) > baseline; i -= 1) addedCount += 1

    if (pinned) {
      timelineRef.current?.scrollToBottom()
    } else {
      setPendingCount((count) => count + addedCount)
    }
  }, [events, pinned])

  const handlePinnedChange = (next: boolean): void => {
    setPinned(next)
    if (next) setPendingCount(0)
  }

  const handleJumpToBottom = (): void => {
    timelineRef.current?.scrollToBottom()
    setPinned(true)
    setPendingCount(0)
  }

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar workspaceId={workspaceId} />
      <div className="flex flex-1 flex-col">
        <TopBar workspaceName={initial.workspace.name} connection={connection} budget={null} />
        <FilterBar
          agents={initial.agents}
          tasks={initial.tasks}
          filters={filters}
          kinds={kinds}
          rawTypes={rawTypes}
          setKinds={setKinds}
          setRawTypes={setRawTypes}
          setAgents={setAgents}
          setTasks={setTasks}
        />
        <div data-testid="sparkline-slot" className="border-b border-line px-3 py-2 text-text-3">
          <Sparkline buckets={sparkline} width={160} height={24} label="tool calls, last 10 minutes" />
        </div>
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <Timeline
            ref={timelineRef}
            events={events}
            workspaceId={workspaceId}
            agentNameById={agentNameById}
            taskTitleById={taskTitleById}
            onPinnedChange={handlePinnedChange}
            onNearTop={loadOlder}
          />
          {pendingCount > 0 && (
            <button
              type="button"
              data-testid="new-events-badge"
              onClick={handleJumpToBottom}
              // Spec §4.6: the badge fades in on appearance — reuses the M5 `action-line-in`
              // opacity keyframe (it's conditionally rendered, so each appearance is already a
              // fresh DOM node; no key trick needed to make the fade replay). It has no explicit
              // fade-*out*: like `AgentPanel`'s `panel-in`, this codebase's motion pass has no
              // exit-animation mechanism, so disappearing (pendingCount back to 0) stays an
              // instant unmount, same as before this change.
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-2 px-3 py-1.5 text-xs text-text-1 shadow-lg motion-safe:animate-[action-line-in_120ms_ease-out]"
            >
              ↓ {pendingCount} new event{pendingCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
