'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useOverview } from '../hooks/useOverview'
import type { OverviewSnapshot } from '../server/overview'
import { SlaveCard } from './SlaveCard'
import { SlavePanel } from './SlavePanel'
import { HaltBanner } from './HaltBanner'
import { postControl } from '../lib/postControl'
import { TopStrip } from './TopStrip'
import { OverviewAdvanced } from './project/OverviewAdvanced'
import { ProjectBrief } from './project/ProjectBrief'
import { RunbookPanel } from './project/RunbookPanel'
import { SupervisorRequest } from './project/SupervisorRequest'
import { SupervisorTimeline } from './project/SupervisorTimeline'
import { Alert } from './ui/Alert'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { PageShell } from './ui/PageShell'
import { Panel } from './ui/Panel'
import { SectionLabel } from './ui/SectionLabel'

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
          <EmptyState testId="blocked-empty" message="nothing needs you" />
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
          <span role="alert" data-testid="blocked-error" className="text-xs text-tone-blocked">
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
          <EmptyState testId="live-events-empty" message="no events yet" />
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
                {/* `feedSummary`'s fallback used to print the dotted event type here, so this
                  * glance panel read `run.started` (M44 R5/R8, found by
                  * `gate:m44-ux-foundation`'s stage 4). It names the family now. The raw type is
                  * deliberately NOT carried onto this row: `liveEvents` is a three-field snapshot
                  * on the RSC wire, and the panel's own `all →` action opens the Activity page,
                  * where every row keeps its `data-event-type` and its kind chip's `title`. */}
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
  const { snapshot, actionLines, liveEvents, connection, error, latencyMs } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedSlaveId, selectSlave] = useSelectedId('slave')
  const selectedSlave = view.slaves.find((slave) => slave.id === selectedSlaveId) ?? null

  // Controller ruling carried from Task 3 (and fix round 1), and re-aimed by M24 §2.2: the
  // project layout's `<ProjectHeader>` and `<ProjectTabs>` render as SIBLINGS of `{children}`, so
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
          {/* M45 R1: the eight facts, first, because "what is happening and what needs me" is the
            * question this page exists to answer. */}
          <ProjectBrief workspaceId={workspaceId} brief={view.brief} onOpenSlave={selectSlave} />
          {/* M45 erratum E17: the raw board counts the design handoff documents and
            * `gate:m14-fidelity` measures, kept under the brief that speaks the domain's words. */}
          <TopStrip snapshot={view} />
          {/* M45 R3 */}
          <SupervisorRequest workspaceId={workspaceId} />
          {/* M48 R7: how this project works, between what you asked for and what happened. */}
          <RunbookPanel workspaceId={workspaceId} view={view.runbook} />
          {/* M45 R2 */}
          <SupervisorTimeline workspaceId={workspaceId} entries={view.timeline} needsYou={view.needsYou} />
          <section id="team" data-testid="team" className="px-[20px] pt-[16px]">
            <SectionLabel>team</SectionLabel>
            {/* M45 erratum E16: the Team strip IS this grid. `SlaveCard` renders nowhere else in
              * the app, and six `gate:m14-fidelity` assertions live on it. R4's worker disclosure
              * is the EXPANDED view -- `SlavePanel`'s Details groups, Task 4.
              *
              * The handoff's 3-column card grid at an 11px gap (design README §3a.1), narrowing to
              * two and then one rather than shrinking the cards past the anatomy they hold. */}
            <div className="grid grid-cols-1 gap-[11px] pt-[8px] md:grid-cols-2 xl:grid-cols-3">
              {view.slaves.map((slave) => (
                <SlaveCard
                  key={slave.id}
                  slave={slave}
                  liveActionLine={actionLines[slave.id] ?? null}
                  workspaceId={workspaceId}
                  onOpen={selectSlave}
                />
              ))}
            </div>
          </section>
          {/* M45 plan erratum E22: the Supervisor panel, `blocked · needs you`, the live-events
            * river and the merge queue, all four unchanged, one disclosure lower. */}
          <OverviewAdvanced workspaceId={workspaceId} view={view} />
        </PageShell>
      </div>
      {selectedSlave !== null && (
        <SlavePanel
          // Keyed on the slave id so switching `?slave=` unmounts the old panel instance instead
          // of reusing it with new props: a control POST still in flight for the slave just
          // switched away from must not paint its late error/pending state onto the next slave's
          // panel — React drops a state update against an unmounted component instead of
          // delivering it (fix round 2, Finding 2).
          key={selectedSlave.id}
          slave={selectedSlave}
          liveEvents={liveEvents[selectedSlave.id] ?? []}
          workspaceId={workspaceId}
          haltedReason={view.workspace.haltedReason}
          onClose={() => selectSlave(null)}
        />
      )}
    </>
  )
}
