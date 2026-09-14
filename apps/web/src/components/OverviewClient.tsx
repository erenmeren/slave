'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { userWorkspaceStatus } from '@slave-of-ai/domain'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useRightPanel } from './shell/RightPanelProvider'
import { useOverview } from '../hooks/useOverview'
import type { OverviewSnapshot } from '../server/overview'
import { SlaveCard } from './SlaveCard'
import { SlavePanel } from './SlavePanel'
import { HaltBanner } from './HaltBanner'
import { WORKSPACE_TONE } from '../lib/tones'
import { NeedsYouCard } from './project/NeedsYouCard'
import { ProjectBrief } from './project/ProjectBrief'
import { RunbookPanel } from './project/RunbookPanel'
import { SupervisorTimeline } from './project/SupervisorTimeline'
import { Alert } from './ui/Alert'
import { EmptyState } from './ui/EmptyState'
import { PageShell } from './ui/PageShell'
import { Panel } from './ui/Panel'
import { StatusPill } from './ui/StatusPill'

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
          <EmptyState testId="live-events-empty" message="no events yet" />
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event) => (
              <li
                key={event.seq}
                data-testid="live-event-row"
                data-event-type={event.type}
                className={`flex items-baseline gap-2 font-mono text-[10.5px] text-text-2 ${
                  event.seq > boundary ? 'motion-safe:animate-[rise_0.3s_ease-out]' : ''
                }`}
              >
                {/* `HH:MM:SS` out of the ISO stamp — the handoff's events panel is a mono time
                  * column, and the date is the same for every row a live panel ever shows. */}
                <span className="shrink-0 text-text-3">{event.ts.slice(11, 19)}</span>
                {/* `feedSummary`'s fallback used to print the dotted event type here, so this
                  * glance panel read `run.started` (M44 R5/R8, found by
                  * `gate:m44-ux-foundation`'s stage 4). It names the family now, and the raw type
                  * -- carried on `liveEvents` since ruling T6-1 -- stays reachable the same way
                  * every other R5 fix keeps it: `data-event-type` on the row, above (docs/ia.md
                  * rule 3). The panel's own `all →` action still opens the Activity page for the
                  * full history; this row no longer has to hide its own type to send someone
                  * there. */}
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
        // The brief calls this one `merge-queue-empty`; the testid in the code has always been
        // `merge-empty` and four cases query it, so the testid is kept and only the component moves.
        <EmptyState testId="merge-empty" message="nothing in the queue" />
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
                  className="shrink-0 rounded-chip border border-tone-waiting/40 px-1.5 py-0.5 font-mono text-[9.5px] text-tone-waiting"
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
  const { snapshot, liveEvents, connection, error, latencyMs } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedSlaveId, selectSlave] = useSelectedId('slave')
  const selectedSlave = view.slaves.find((slave) => slave.id === selectedSlaveId) ?? null

  // Controller ruling carried from Task 3 (and fix round 1), and re-aimed by M24 §2.2: the
  // shell header and the sidebar tree are mounted by the ROOT layout, above every page, so
  // this component can never be their ancestor. This page already streams the workspace, and
  // every figure the header and the Tasks tab's badge show is in the snapshot it is already
  // holding — so it publishes them to `hooks/useShellFacts.ts` and the header opens nothing of
  // its own. A module store, not context, for the same reason: no shared ancestor to hold it.
  // `slavesWorking` is the same `status === 'working'` count the strip's first tile shows, and
  // `tasksActive` the same `tasks.active` the Tasks tab's badge does; the strip and the tab strip
  // cannot disagree, because there is one number.
  const shellFacts = useMemo(
    () => ({
      workspace: { id: view.workspace.id, name: view.workspace.name },
      counts: {
        slavesWorking: view.slaves.filter((a) => a.status === 'working').length,
        tasksActive: view.tasks.active,
        slavesPaused: view.slaves.filter((a) => a.status === 'paused').length,
      },
      guardrails: {
        budgetUsd: view.workspace.budgetUsd,
        maxConcurrentRuns: view.workspace.maxConcurrentRuns,
        runTimeoutMs: view.workspace.runTimeoutMs,
        maxAttempts: view.workspace.maxAttempts,
      },
      // M24 §2.2 widening: the same four figures the header renders, already sitting on this
      // snapshot's `workspace` -- `overview.ts` computes them the identical way `buildShellFacts`
      // now does, so there is nothing left to derive.
      status: {
        goal: view.workspace.goal,
        spentUsd: view.workspace.spentUsd,
        unmeasuredRuns: view.workspace.unmeasuredRuns,
        haltedReason: view.workspace.haltedReason,
      },
    }),
    [view],
  )
  useEffect((): void => {
    publishShellFacts(workspaceId, shellFacts)
  }, [workspaceId, shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the header would flip to
  // its fallback facts (this page's own SSR snapshot) between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])
  useEffect((): void => {
    publishStreamState(workspaceId, { connection, latencyMs })
  }, [workspaceId, connection, latencyMs])
  useEffect((): (() => void) => () => publishStreamState(workspaceId, null), [workspaceId])

  // Band 1's pill: the same word `ProjectsClient`'s card says about this same project, from the
  // same `userWorkspaceStatus`. `archived: false` because `OverviewSnapshot.workspace` carries no
  // archived flag -- an archived project's Overview is reachable and its chip lives on the
  // Projects card, which is the surface that can restore it.
  const workspaceStatus = userWorkspaceStatus({
    archived: false,
    halted: view.workspace.haltedReason !== null,
    needsYouCount: view.needsYou.length,
    tasksActive: view.tasks.active,
  })

  // README "Overview" → Supervisor tile: `Runbook <name> · stage 3/5 Verify`. Composed here rather
  // than in `server/brief.ts` because `ProjectBrief` the DTO has no runbook field and this
  // milestone adds no read-model field -- `view.runbook` is already on the snapshot for the panel
  // below. `RunbookPanelView.currentStage` is a stage KEY and `RunbookStageView` has `key`/`title`
  // (no `name`), so the index comes off the key and the WORD printed is the title, exactly as
  // `RunbookPanel` itself reads them. A project with no adopted runbook has no line.
  const runbookLine = ((): string | null => {
    const runbook = view.runbook
    if (runbook?.adopted == null) return null
    const stageIndex = runbook.stages.findIndex((stage) => stage.key === runbook.currentStage)
    const stage = runbook.stages[stageIndex]
    const position =
      stage === undefined
        ? ''
        : ` · stage ${String(stageIndex + 1)}/${String(runbook.stages.length)} ${stage.title}`
    return `Runbook ${runbook.adopted.name}${position}`
  })()

  const { open: openPanel, close: closePanel, mode: panelMode } = useRightPanel()

  // What the URL names RIGHT NOW, readable from a closure created for an earlier subject. The
  // provider calls the PREVIOUS owner's clearer whenever a DIFFERENT subject takes the slot
  // (ruling T3-4) -- and that includes this page moving its own selection from one worker to the
  // next, where the "previous owner" is this same page and its selection has already moved on.
  // Clearing then would cancel a selection one frame after a person made it, so the clearer only
  // fires while the URL still names the worker it was created for.
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedSlave?.id ?? null

  /**
   * Ruling T5-1 -- the two refs that keep an UNMOUNTED page out of the slot.
   *
   * The provider outlives this page: it is the root layout's, and navigating from one section to
   * another unmounts the page under it. Without these, a worker opened here left a clearer
   * behind that a LATER page's `open()` would run (ruling T3-4 fires the previous owner's clearer
   * whenever a different subject takes the slot) -- and that clearer calls `router.replace` with
   * the pathname this page was rendered on, bouncing a person off the page they just opened. The
   * panel itself also stayed on screen over a section that has nothing to do with it.
   *
   * `mounted` is re-armed on every mount rather than only cleared on unmount, because React's
   * StrictMode mounts, unmounts and remounts an effect in development.
   */
  const mounted = useRef(true)
  /** True while the slot holds THIS page's content. Set where `open()` is called, cleared the
   *  moment the clearer runs -- which is the provider telling us the slot has been taken or
   *  closed, whether by another owner, the slot's own `✕`, or the dock. */
  const owned = useRef(false)
  useEffect((): (() => void) => {
    mounted.current = true
    return (): void => {
      mounted.current = false
      // Hand the slot back on the way out, but only if it is still ours: another page may already
      // have taken it, and closing then would shut a panel this one does not own.
      if (owned.current) closePanel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount and unmount only. `closePanel`
    // is the provider's stable `useCallback`; depending on it would re-run this cleanup mid-life
    // and close a panel nobody asked to close.
  }, [])

  // M57 R8 / plan errata E4-E5: `?slave=` is still the source of truth and still what a refresh
  // restores -- this only MIRRORS it into the shell's right panel, which is where the panel is
  // drawn now. The clearer handed to `open` is the same one the panel's own close used, so the
  // slot's `»`, the slot's `✕` and the panel's own control all clear the URL together.
  //
  // THE DEPENDENCY LIST IS `selectedSlave?.id` AND NOTHING ELSE (scan finding 21). `liveEvents` and
  // `view` change identity on every SSE frame, and an effect that re-`open()`s several times a
  // second is an effect that fights the person who just collapsed the panel. What the panel reads
  // out of those two is read at OPEN time and refreshed by its own props on the next genuine open;
  // the fourth argument to `open` is the content KEY, which is what lets the provider tell a
  // re-assertion of the same slave from a new one.
  //
  // AND IT HANDLES THE CLEAR. `?slave=` can go away by navigation rather than by the close button
  // — a link, a Back — and an effect that only ever opens would leave the provider holding a stale
  // `slave` mode over a page that has no selection.
  useEffect((): void => {
    if (selectedSlave === null) {
      if (panelMode === 'slave') closePanel()
      return
    }
    const openedFor = selectedSlave.id
    openPanel(
      'slave',
      <SlavePanel
        // Keyed on the slave id so switching `?slave=` unmounts the old instance instead of
        // reusing it with new props: a control POST still in flight for the slave just switched
        // away from must not paint its late error onto the next slave's panel (M45 fix round 2).
        key={selectedSlave.id}
        slave={selectedSlave}
        liveEvents={liveEvents[selectedSlave.id] ?? []}
        workspaceId={workspaceId}
        haltedReason={view.workspace.haltedReason}
        onClose={() => {
          selectSlave(null)
          closePanel()
        }}
      />,
      () => {
        owned.current = false
        if (mounted.current && selectedIdRef.current === openedFor) selectSlave(null)
      },
      openedFor,
    )
    // AFTER the call, not before: `open()` runs the OUTGOING clearer first, and that clearer is
    // this page's own when the selection simply moved -- setting the flag first would let it clear
    // the very ownership it is announcing.
    owned.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the SELECTION
    // and not on the snapshot: see the note above. `panelMode` is read, not depended on, for the
    // same reason (it changes when this effect's own `close()` lands).
  }, [selectedSlave?.id])

  return (
    <>
      {/* The stale-data dim stays OUTSIDE the shell (M45 t3): `PageShell` owns the frame and takes
        * no className, and the page-shell marker has to be the element whose direct children are
        * the page's own sections. */}
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        {/* M45 erratum E18: `flush`, because every `/w/:id/*` page already carries the design
          * handoff's own `px-[20px] pt-[16px]` gutters and `gate:m14-fidelity` screenshots this
          * one. The shell is here for its LANDMARK and its marker, not for its padding. */}
        <PageShell flush>
          {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
          {/* M44 R3: the band three surfaces hand-rolled, each with its own class string, is
            * `ui/Alert` now. The one-line `role="alert"` refusal sentences under forms are NOT
            * alerts in this sense and stay exactly as they are (erratum E21). */}
          {error !== null && <Alert variant="notice">showing stale data: {error}</Alert>}
          {view.workspace.adoptedFrom !== null && (
            // M44 R3: the second full-width band on this page, the same component as the first --
            // but the `info` variant (fix round 1), which is `role="status"` on the page's own
            // neutral surface. Where the line above is a warning that needs reading NOW, this one
            // is standing provenance: true for the life of the project, needing nobody. Announcing
            // it on insertion, in the same amber, was a warning about nothing.
            <Alert variant="info" testId="ws-adopted-from">
              organisation adopted from simulation{' '}
              <Link href={`/sim/${view.workspace.adoptedFrom.simulationId}`} className="underline">
                {view.workspace.adoptedFrom.name}
              </Link>
            </Alert>
          )}
          {/* README "Overview", band 1: the project's name, its one word, and the goal under it.
            * This is where the brief's deleted `objective` tile went -- a goal is what the project
            * IS, not one fact among four. */}
          <section data-testid="project-title" className="px-[24px] pt-[22px]">
            <div className="flex items-center gap-3">
              <h1 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-t1">{view.workspace.name}</h1>
              <StatusPill tone={WORKSPACE_TONE[workspaceStatus.state]} label={workspaceStatus.label} title={workspaceStatus.state} />
            </div>
            {/* TWO LINES, with the whole of it one hover away (ruling T6-3) -- the deleted
              * `objective` tile's own idiom. A goal DOCUMENT is paragraphs long and grows with
              * every `requestChange` (which appends a dated line to it), so an unclamped line here
              * pushes the fact tiles below the fold `gate:m45` stage 1 measures. */}
            <p
              data-testid="project-goal-line"
              {...(view.brief.objective.text === null ? {} : { title: view.brief.objective.text })}
              className="mt-[6px] line-clamp-2 text-[13.5px] text-t2"
            >
              {view.brief.objective.version > 0 && `Goal v${String(view.brief.objective.version)} · `}
              {view.brief.objective.text ?? 'no goal yet'}{' '}
              <Link href={`/w/${workspaceId}/settings`} className="font-medium text-accent">
                Edit goal
              </Link>
            </p>
          </section>

          {/* Band 2: what is waiting on a person, above everything the project did on its own.
            * No `onRefresh` (ruling P18): approve and reject append events, this page's own stream
            * wakes on them, and the snapshot is refetched 250 ms later by the loop every other
            * control here already rides. */}
          <NeedsYouCard workspaceId={workspaceId} items={view.needsYou} />

          {/* Band 3: the four fact tiles (M57 R17). The container carries `strip` as well as
            * `brief` -- `TopStrip` is gone and three gates wait on that marker for "the Overview
            * has rendered". */}
          <ProjectBrief workspaceId={workspaceId} brief={view.brief} runbookLine={runbookLine} />

          {/* Band 4: the Team ROWS (M57 R18). `SlaveCard` is a row now, so this section owns only
            * the surface around them; the six-track grid is the row's own. `#team` stays -- it is
            * an anchor other surfaces link to -- and so does the `team` testid. */}
          <section id="team" data-testid="team" className="px-[24px] pt-[18px]">
            <div className="mb-[10px] flex items-center justify-between">
              <span className="font-semibold text-t1">
                Team <span className="font-mono text-[12px] font-medium text-t3">{view.slaves.length}</span>
              </span>
              <Link href={`/w/${workspaceId}/organization`} className="text-[13px] font-medium text-accent">
                Open Team →
              </Link>
            </div>
            <div className="overflow-hidden rounded-panel-card border border-line bg-card">
              {view.slaves.length === 0 ? (
                // The deleted `team` tile said this, and an empty bordered box says nothing
                // (`docs/ia.md` rule 2: the fact moved here with the rows).
                <EmptyState testId="team-empty" message="nobody works here yet" />
              ) : (
                view.slaves.map((slave) => (
                  // THREE props. `liveActionLine` is gone with the `action-line` the row no longer
                  // draws (M57 R18) -- the panel the `⋯` opens renders the live line already.
                  <SlaveCard key={slave.id} slave={slave} workspaceId={workspaceId} onOpen={selectSlave} />
                ))
              )}
            </div>
          </section>

          {/* M48 R7: how this project works, between who is doing it and what happened. Unchanged
            * -- `gate:m48-runbooks` reads eleven of its testids, and band 3's Supervisor tile
            * carries the one-line SUMMARY of it. */}
          <RunbookPanel workspaceId={workspaceId} view={view.runbook} />

          {/* Band 5: Recent changes. M45 R2's six-lane timeline with its own testids untouched,
            * plus the two panels Task 4 parked on the page. */}
          <section data-testid="recent-changes" className="flex flex-col gap-3 px-[24px] py-[18px]">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-t1">Recent changes</span>
              <Link href={`/w/${workspaceId}/activity`} className="text-[13px] font-medium text-accent">
                All activity →
              </Link>
            </div>
            <SupervisorTimeline workspaceId={workspaceId} entries={view.timeline} needsYou={view.needsYou} />
            <div className="flex gap-3">
              <LiveEventsPanel workspaceId={workspaceId} events={view.liveEvents} />
              <MergeQueuePanel queue={view.mergeQueue} />
            </div>
          </section>
        </PageShell>
      </div>
    </>
  )
}
