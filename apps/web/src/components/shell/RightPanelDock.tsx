'use client'

import Link from 'next/link'
import { useRightPanel } from './RightPanelProvider'

/**
 * The 52px rail the panel collapses to (M57 R8, README "Shell" → Right panel).
 *
 * Two buttons: the accent `S` that brings the Supervisor back, carrying the pending-decision count
 * as a badge, and an `A` that goes to Activity. The badge is the whole reason the dock is not just
 * an empty gutter: a person who collapsed the panel still has to be told when something is waiting
 * on them.
 */
export function RightPanelDock({
  workspaceId,
  pendingDecisions,
}: {
  readonly workspaceId: string
  readonly pendingDecisions: number
}): React.JSX.Element {
  const { expand } = useRightPanel()
  return (
    <div
      data-testid="right-dock"
      className="flex w-[52px] flex-none flex-col items-center gap-2 border-l border-line bg-panel py-3"
    >
      <button
        type="button"
        data-testid="dock-supervisor"
        title="Supervisor"
        aria-label={pendingDecisions > 0 ? `Supervisor, ${String(pendingDecisions)} waiting on you` : 'Supervisor'}
        onClick={expand}
        className="relative grid h-[34px] w-[34px] place-items-center rounded-panel border-0 bg-accent font-mono text-[13px] font-semibold text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        S
        {pendingDecisions > 0 && (
          <span
            data-testid="dock-badge"
            className="absolute -right-1 -top-1 grid h-[16px] min-w-[16px] place-items-center rounded-pill border-2 border-panel bg-s-waiting px-1 font-mono text-[10px] font-semibold text-white"
          >
            {pendingDecisions}
          </span>
        )}
      </button>
      <Link
        data-testid="dock-activity"
        href={`/w/${workspaceId}/activity`}
        title="Activity"
        aria-label="Activity"
        className="grid h-[34px] w-[34px] place-items-center rounded-panel border border-line2 font-mono text-[12px] font-semibold text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        A
      </Link>
    </div>
  )
}
