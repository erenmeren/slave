'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useActivityStream } from '../../hooks/useActivityStream'
import { announceProjectName } from '../../hooks/useProjectName'
import { publishShellFacts } from '../../hooks/useShellFacts'
import { useUrlFilters } from '../../hooks/useUrlFilters'
import type { ActivityPage } from '../../server/activity'
import type { ShellFacts } from '../../server/shell'
import { HaltBanner } from '../HaltBanner'
import { Sparkline } from '../Sparkline'
import { TopBar } from '../TopBar'
import { PanelHeader } from '../ui/PanelHeader'
import { FilterBar } from './FilterBar'
import { Timeline, type TimelineHandle } from './Timeline'

/**
 * How long the page waits after the newest event before re-reading the shell facts. A burst of
 * arrivals -- which is the normal shape of this page's traffic -- therefore costs one request, not
 * one per event, and the sidebar is never more than a beat behind the river it sits beside. Longer
 * than `useWorkspaceStream`'s own 250ms notification debounce on purpose: these are two counts and
 * four guardrails on a nav, not the page's own content.
 */
export const SHELL_REFETCH_DEBOUNCE_MS = 1_000

/**
 * The activity page's client shell: TopBar (workspace name is static from the initial server
 * snapshot — only `connection` is live, same as `TasksClient`) + `FilterBar` + a header
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

  // Fills the global shell's Sidebar project-section header with this workspace's real name
  // (M11 Task 10 ruling 2) — the root layout mounts one <Sidebar> with no per-route params of its
  // own, so this is how it learns the name rather than showing the bare workspaceId forever.
  useEffect((): void => {
    announceProjectName(workspaceId, initial.workspace.name)
  }, [workspaceId, initial.workspace.name])

  // The newest seq the page opened with. Compared against, never updated: once anything at all has
  // arrived the newest seq has moved off it for good, and a `loadOlder` prepend cannot move it
  // back (a prepend only ever adds SMALLER seqs).
  const mountSeqRef = useRef<number | null>(events.at(-1)?.seq ?? null)

  // The shell facts as of the last refetch, or `null` while the server-rendered ones are still
  // the freshest thing this page has.
  //
  // Why this exists at all (fix round 1, Important 1): `useActivityStream` streams EVENTS and pages
  // history -- it never re-derives the page DTO -- so `initial.shellFacts` is frozen at server
  // render. Publishing only that would leave the sidebar's counts and guardrails stuck at load
  // time for the whole visit, on the very page a person watches longest, and the fallback stream
  // that used to keep them moving was removed by this same task. `TasksClient`/`GraphClient`
  // publish a live snapshot because their own hooks refetch one; this page has to ask for it.
  const [refetchedFacts, setRefetchedFacts] = useState<ShellFacts | null>(null)
  const newestSeq = events.at(-1)?.seq ?? null

  useEffect((): (() => void) | undefined => {
    // Mount is not a reason to refetch: `initial.shellFacts` came out of the same server render as
    // the seed page, so the first thing published is already current. Only a CHANGE in the newest
    // seq -- an arrival, or a filter reload landing a different page -- asks for a fresh read.
    if (newestSeq === null || newestSeq === mountSeqRef.current) return undefined

    let cancelled = false
    const timer = setTimeout((): void => {
      void (async (): Promise<void> => {
        try {
          const response = await fetch(`/api/w/${workspaceId}/shell`)
          if (!response.ok) return
          const body = (await response.json()) as ShellFacts
          if (!cancelled) setRefetchedFacts(body)
        } catch {
          // Keep the last good figures rather than blanking a nav over a transient failure.
        }
      })()
    }, SHELL_REFETCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspaceId, newestSeq])

  // Controller ruling carried from Task 3/8, and CLOSED here: Activity is the last of the four
  // workspace pages, so with this publication the sidebar has no route left that fails to publish
  // — `Sidebar.tsx`'s standalone fallback `EventSource` is gone (a one-shot fetch remains as the
  // belt-and-braces path for a route that somehow does not publish). Same idiom as
  // `OverviewClient`/`TasksClient`/`GraphClient`.
  useEffect((): void => {
    publishShellFacts(workspaceId, refetchedFacts ?? initial.shellFacts)
  }, [workspaceId, refetchedFacts, initial.shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the sidebar would blank its
  // figures between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])

  const agentNameById = useMemo(() => new Map(initial.agents.map((agent) => [agent.id, agent.name])), [initial.agents])
  const taskTitleById = useMemo(() => new Map(initial.tasks.map((task) => [task.id, task.title])), [initial.tasks])

  // The roster row a click has selected, or `null`. Design README "Filtering": clicking a roster
  // row filters the stream — as a DIM (opacity .35), not a removal, so the river keeps its shape
  // and its timestamps stay comparable. Deliberately NOT `useUrlFilters`' `?agents=`: that one
  // re-queries the server and drops every other agent's rows outright, which is exactly the
  // behaviour this one exists not to be.
  const [rosterAgentId, setRosterAgentId] = useState<string | null>(null)

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

  // The widest bar is always 100%: `typeVolumes` is sorted count-descending by the server, so the
  // first row IS the maximum. `?? 1` never divides by zero — an empty `typeVolumes` renders no
  // bars at all, so the value goes unused in that case.
  const volumeMax = initial.typeVolumes[0]?.count ?? 1

  const handleJumpToBottom = (): void => {
    timelineRef.current?.scrollToBottom()
    setPinned(true)
    setPendingCount(0)
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* `latencyMs={null}` (M14 Task 3): `useActivityStream` wraps its own `EventSource` rather
        * than `useWorkspaceStream` and measures no arrival age. `sse · —` is the honest reading
        * for a chip with no measurement; widening that hook is not this task's scope. */}
      <TopBar
        workspaceId={workspaceId}
        workspaceName={initial.workspace.name}
        connection={connection}
        latencyMs={null}
        budget={null}
        halted={initial.workspace.haltedReason !== null}
      />
      {initial.workspace.haltedReason !== null && <HaltBanner reason={initial.workspace.haltedReason} />}
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
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <Timeline
            ref={timelineRef}
            events={events}
            workspaceId={workspaceId}
            agentNameById={agentNameById}
            taskTitleById={taskTitleById}
            dimmedAgentId={rosterAgentId}
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
              // instant unmount, same as before this change. NOT the rows' `rise`: this is a
              // control appearing, not an event arriving.
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-2 px-3 py-1.5 text-xs text-text-1 shadow-lg motion-safe:animate-[action-line-in_120ms_ease-out]"
            >
              ↓ {pendingCount} new event{pendingCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {/* The right rail (design README §3a.5: "the 1c timeline + a right rail of event-type
          * volumes"), with 1c's roster below it. */}
        <aside data-testid="activity-rail" className="w-[280px] flex-none overflow-y-auto border-l border-line p-4">
          <PanelHeader title="event types · 24h" />
          <div className="mt-[11px] flex flex-col gap-[9px]">
            {initial.typeVolumes.map((volume) => (
              <div key={volume.prefix} data-testid="volume-bar" data-prefix={volume.prefix}>
                <div className="flex justify-between font-mono text-[10.5px] text-text-2">
                  <span>{volume.prefix}</span>
                  <span className="text-text-3">{volume.count}</span>
                </div>
                <div className="mt-[4px] h-[4px] overflow-hidden rounded-[2px] bg-white/[0.06]">
                  {/* Normalized to the BUSIEST kind, not to a fixed ceiling: the rail compares
                    * kinds against each other, and a fixed scale would flatten a quiet day into
                    * six invisible bars. `width .5s ease` is the handoff's own bar transition. */}
                  <div
                    data-testid="volume-fill"
                    className="h-full bg-tone-working motion-safe:[transition:width_.5s_ease]"
                    style={{ width: `${Math.round((volume.count / volumeMax) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {initial.typeVolumes.length === 0 && (
              // A kind with no events in the window is OMITTED, never drawn as a zero bar
              // (`ActivityPage.typeVolumes`) — so a silent 24 hours has nothing to draw at all,
              // and says so rather than showing an empty box.
              <p data-testid="volume-empty" className="font-mono text-[10.5px] text-text-3">
                no events in the last 24h
              </p>
            )}
          </div>
          <div className="mt-6">
            <PanelHeader title="roster" />
            <ul className="mt-[11px] flex flex-col gap-1">
              {initial.agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    data-testid={`roster-row-${agent.id}`}
                    // A toggle, not a radio: clicking the selected row again clears the filter,
                    // which is the only way back to the undimmed river without a reload.
                    aria-pressed={rosterAgentId === agent.id}
                    onClick={() => setRosterAgentId((current) => (current === agent.id ? null : agent.id))}
                    className={`w-full truncate rounded-nav px-2 py-1 text-left text-[12.5px] transition-colors ${
                      rosterAgentId === agent.id ? 'bg-[#151a21] text-text-1' : 'text-text-2 hover:text-text-1'
                    }`}
                  >
                    {agent.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}
