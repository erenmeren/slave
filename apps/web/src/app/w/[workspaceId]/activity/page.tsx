import { buildActivityDigest } from '../../../../server/activityDigest'
import { buildActivityPage } from '../../../../server/activity'
import { buildOverviewSnapshot } from '../../../../server/overview'
import { ActivityClient, type RecentChanges } from '../../../../components/activity/ActivityClient'
import { ActivityDigest } from '../../../../components/project/ActivityDigest'

export const dynamic = 'force-dynamic'

// Named `ActivityPageRoute` rather than `ActivityPage` (the `TasksPage`/`OverviewPage` sibling
// convention) — `ActivityPage` is already the exported type name in `server/activity.ts`.
//
// M61 R10/Task 7: `?view=digest` is simple mode's own Activity tab (`lib/routes.ts`'s `TABS`
// already links there); everything else -- no `view`, or any other value -- is the developer
// tab's raw river. Both read the SAME `workspaceId`; only which builder(s) run and which client
// renders differs.
export default async function ActivityPageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const query = await searchParams
  const view = typeof query['view'] === 'string' ? query['view'] : undefined

  if (view === 'digest') {
    const days = await buildActivityDigest(workspaceId)
    return <ActivityDigest key={workspaceId} workspaceId={workspaceId} days={days} />
  }

  // Controller Ruling 6: the river gains a `recent-changes` section (`SupervisorTimeline` +
  // `LiveEventsPanel` + `MergeQueuePanel`) at the bottom, fed by `buildOverviewSnapshot` -- the
  // narrowest existing builder that yields `timeline`, `liveEvents` AND `mergeQueue` together (no
  // narrower one composes all three without re-deriving what `buildOverviewSnapshot` already
  // reads). Run alongside `buildActivityPage`, not after it: two independent reads, one round.
  const [snapshot, overview] = await Promise.all([buildActivityPage(workspaceId), buildOverviewSnapshot(workspaceId)])
  if (snapshot === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL. `recent` is genuinely OMITTED rather
  // than passed as `undefined` (`exactOptionalPropertyTypes`) when the workspace vanished between
  // the two reads above -- `snapshot !== null` already ruled that out for `buildActivityPage`'s
  // own read, but `buildOverviewSnapshot`'s is a separate query and can still race it.
  if (overview === null) return <ActivityClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} />
  const recent: RecentChanges = {
    timeline: overview.timeline,
    needsYou: overview.needsYou,
    liveEvents: overview.liveEvents,
    mergeQueue: overview.mergeQueue,
  }
  return <ActivityClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} recent={recent} />
}
