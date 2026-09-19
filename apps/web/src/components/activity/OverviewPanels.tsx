'use client'

import { useRef } from 'react'
import Link from 'next/link'
import type { OverviewSnapshot } from '../../server/overview'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'

/**
 * The 340px live-events panel with the handoff's `all →` action (design README §3a.1).
 *
 * MOVED here, unchanged, out of `components/OverviewClient.tsx` (M61 R7/Task 6): the Overview page
 * that carried it is gone, and Task 7's raw activity river is this panel's new home. Nothing about
 * its own behaviour changes in this move.
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
 *
 * MOVED here, unchanged, alongside `LiveEventsPanel` (M61 R7/Task 6).
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
