'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { OverviewSnapshot } from '../../server/overview'
import { BlockedPanel, LiveEventsPanel, MergeQueuePanel } from '../OverviewClient'
import { SupervisorPanel } from '../SupervisorPanel'

/**
 * Everything the Overview kept but stopped putting first (M45 R1, plan erratum E22).
 *
 * NOTHING WAS REMOVED. The Supervisor panel, `blocked · needs you`, the live-events river and the
 * merge queue are the same four components, with the same testids, the same widths and the same
 * tests -- they are simply below a disclosure now, because the first viewport of this page belongs
 * to the brief, the request box and the timeline.
 *
 * Its children render only when it is OPEN, and that is load-bearing rather than tidy:
 * `SupervisorPanel` opens a `RepeatableRead` world load plus two decision queries every time it is
 * woken, and the overview's stream wakes it several times a second while a run is live. A closed
 * disclosure must cost nothing.
 *
 * The disclosure is CONTROLLED (`open={open}`, with the summary's own default prevented) rather
 * than left to the browser's native toggle: the same click has to do the same thing in a browser
 * and in jsdom, and `<details>`' native activation behaviour is not something a component test can
 * rely on.
 */
export function OverviewAdvanced({
  workspaceId,
  view,
}: {
  readonly workspaceId: string
  readonly view: OverviewSnapshot
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details data-testid="overview-advanced" open={open} className="px-[20px] pb-[20px] pt-[16px]">
      <summary
        data-testid="overview-advanced-toggle"
        onClick={(event) => {
          event.preventDefault()
          setOpen((was) => !was)
        }}
        className="cursor-pointer list-none font-mono text-[9px] uppercase tracking-[.09em] text-text-3 hover:text-text-2"
      >
        Advanced <span aria-hidden>▾</span>
      </summary>
      {open && (
        <div className="flex flex-col gap-[11px] pt-[11px]">
          {/* M38 §6 put the Supervisor directly under the halt banner; M45 moves it here and keeps
            * every word of it. `refreshKey` is still the overview's SSE-driven refetch -- `view`'s
            * identity changes on each one -- and the panel still throttles its own reads. */}
          <div data-testid="advanced-panel-supervisor">
            <SupervisorPanel workspaceId={workspaceId} refreshKey={view} />
          </div>
          {/* The design README's bottom row, unchanged: "blocked · needs you" takes the remaining
            * width beside the fixed 340px live-events panel, with the merge queue underneath. */}
          <div className="flex gap-[11px]">
            <BlockedPanel workspaceId={workspaceId} items={view.blocked} />
            <LiveEventsPanel workspaceId={workspaceId} events={view.liveEvents} />
          </div>
          <MergeQueuePanel queue={view.mergeQueue} />
          {/* The same three destinations the project tab strip's own `Advanced ▾` menu lists
            * (`docs/ia.md`), reachable from the page as well as from the header. */}
          <div className="flex flex-wrap gap-3 text-xs text-text-2">
            <Link data-testid="advanced-link-graph" href={`/w/${workspaceId}/graph`} className="underline">
              Graph
            </Link>
            <Link data-testid="advanced-link-office" href={`/w/${workspaceId}/office`} className="underline">
              Office
            </Link>
            <Link data-testid="advanced-link-analytics" href={`/analytics?workspace=${workspaceId}`} className="underline">
              Analytics
            </Link>
          </div>
        </div>
      )}
    </details>
  )
}
