'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { workspaceIdOf } from '../../lib/routes'
import { useShellFacts } from '../../hooks/useShellFacts'
import { SupervisorThreadPanel, type PendingDecision } from '../supervisor/SupervisorThreadPanel'
import { RightPanel } from './RightPanel'
import { RightPanelDock } from './RightPanelDock'
import { useRightPanel } from './RightPanelProvider'

/** One array, so "nothing read yet" does not hand the panel a new identity on every render. */
const NONE_PENDING: readonly PendingDecision[] = []

/**
 * What goes in the grid's third column, and how wide it is (M57 R8).
 *
 * NOTHING on a global route: `/`, `/workforce`, `/settings`, `/sim*` and `/analytics` have no
 * project to supervise, and a dock on them would be a button that opens an empty panel. Inside a
 * project it is the 372px panel, or the 52px dock once somebody has collapsed it.
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
  const { collapsed } = useRightPanel()
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
  if (collapsed) return <RightPanelDock workspaceId={workspaceId} pendingDecisions={decisions.length} />
  return (
    <RightPanel>
      <SupervisorThreadPanel workspaceId={workspaceId} pending={decisions} />
    </RightPanel>
  )
}
