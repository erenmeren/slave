'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { workspaceIdOf } from '../../lib/routes'
import { useShellFacts } from '../../hooks/useShellFacts'
import { SupervisorThreadPanel, type PendingDecision } from '../supervisor/SupervisorThreadPanel'
import { RightPanel } from './RightPanel'
import { RightPanelDock } from './RightPanelDock'
import { useRightWidth } from './RightColumn'

/** One array, so "nothing read yet" does not hand the panel a new identity on every render. */
const NONE_PENDING: readonly PendingDecision[] = []

/**
 * What goes in the grid's third column, and how wide it is (M57 R8, M61 R14).
 *
 * NOTHING on a global route: `/`, `/workforce`, `/settings`, `/sim*` and `/analytics` have no
 * project to supervise, and a dock on them would be a button that opens an empty panel. Inside a
 * project it is the 340px panel, the 52px dock once somebody has collapsed it, or -- below 1280px
 * -- the same panel content `position: fixed` at the right, OUTSIDE the grid entirely (`useRightWidth`
 * already took the project and the collapse state into account; this component only has to ask it
 * which of the three to draw).
 *
 * The pending-decision count the dock badges comes from one small read this component makes for
 * itself, refetched on the same wake-up everything else in the shell uses (`useShellFacts`'s
 * identity). It is a COUNT and not the decisions themselves: the panel below fetches those when it
 * is open, and the dock only has to know whether the number is zero.
 */
export function RightPanelHost(): React.JSX.Element | null {
  const pathname = usePathname()
  const workspaceId = workspaceIdOf(pathname)
  const facts = useShellFacts(workspaceId)
  const width = useRightWidth()
  /** Tagged with the project it was read FOR. The state survives a navigation from one project to
   *  the next, and a badge carrying the last project's number is worse than no badge at all --
   *  the same "one workspace at a time" rule `hooks/useShellFacts.ts` states for its own store. */
  const [pending, setPending] = useState<{ readonly workspaceId: string; readonly list: readonly PendingDecision[] } | null>(null)

  // ONE fetch of this endpoint on this page (scan finding 22). The draft had this component fetch
  // `/api/w/:id/supervisor` for the dock's badge and `SupervisorThreadPanel` fetch the SAME endpoint
  // for the SAME `pending` array — two identical round trips per wake-up, for one number and one
  // list that are the same list. The host owns the fetch and passes the list down: the panel draws
  // the proposals, the dock counts them, and neither asks for them itself.
  useEffect((): (() => void) | undefined => {
    if (workspaceId === null) return undefined
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/w/${workspaceId}/supervisor`)
        if (!response.ok) return
        const view = (await response.json()) as { pending?: readonly PendingDecision[] }
        if (!cancelled) setPending({ workspaceId, list: view.pending ?? [] })
      } catch {
        /* the list stays as it was: a count that fails to refresh is better than one that lies */
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [workspaceId, facts])

  if (workspaceId === null) return null
  const decisions = pending?.workspaceId === workspaceId ? pending.list : NONE_PENDING
  if (width === 'dock') return <RightPanelDock workspaceId={workspaceId} pendingDecisions={decisions.length} />
  if (width === 'overlay') {
    return (
      <div data-testid="right-overlay" className="glass fixed inset-y-0 right-0 z-30 w-[340px] border-l border-line shadow-resting">
        <RightPanel>
          <SupervisorThreadPanel workspaceId={workspaceId} pending={decisions} />
        </RightPanel>
      </div>
    )
  }
  return (
    <RightPanel>
      <SupervisorThreadPanel workspaceId={workspaceId} pending={decisions} />
    </RightPanel>
  )
}
