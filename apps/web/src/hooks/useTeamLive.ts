'use client'

import { useEffect } from 'react'
import { publishShellFacts } from './useShellFacts'
import { useWorkspaceStream, type WorkspaceStreamState } from './useWorkspaceStream'
import type { TeamLiveSnapshot } from '../server/teamLive'

/**
 * The Team tab's live wiring (M61 R7/Task 6): `useWorkspaceStream` over `/api/w/:id/team`, plus the
 * shell-facts publish/unpublish pair `OverviewClient.tsx:170-182` used to own. `TeamLive` is the
 * ONLY page client that publishes on `/w/:id` now.
 *
 * No `useMemo` reshaping the way `OverviewClient` needed (its `OverviewSnapshot` carried the
 * header's figures as loose fields on `workspace`) -- `TeamLiveSnapshot.shellFacts` (Task 5) is
 * already the exact `ShellFacts` shape `buildShellFacts` builds, so a snapshot's own field is
 * published as-is.
 */
export function useTeamLive(workspaceId: string, initial: TeamLiveSnapshot): WorkspaceStreamState<TeamLiveSnapshot> {
  const state = useWorkspaceStream<TeamLiveSnapshot>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/team`,
    initial,
    onSnapshot: (snapshot) => publishShellFacts(workspaceId, snapshot.shellFacts),
  })

  // The mount-time publish `onSnapshot` alone cannot give: the stream's first refetch lands after
  // the SSE `onopen` plus a 250ms debounce, and the header must not show its own fallback facts for
  // that whole window. `initial` is this component's own SSR snapshot and does not change identity
  // across the page's life, so this runs once, on mount -- the same rule `OverviewClient.tsx:175-177`
  // states for its own mount publish.
  useEffect((): void => {
    publishShellFacts(workspaceId, initial.shellFacts)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only, see the note above.
  }, [workspaceId])

  // Retraction is its own effect, keyed only on the workspace (`OverviewClient.tsx:178-181`):
  // folding it into the publish's cleanup would retract and re-publish on every snapshot, flashing
  // the header to its fallback facts between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])

  return state
}
