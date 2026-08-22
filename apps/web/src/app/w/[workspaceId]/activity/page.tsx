import { buildActivityPage } from '../../../../server/activity'
import { ActivityClient } from '../../../../components/activity/ActivityClient'

export const dynamic = 'force-dynamic'

// Named `ActivityPageRoute` rather than `ActivityPage` (the `TasksPage`/`OverviewPage` sibling
// convention) — `ActivityPage` is already the exported type name in `server/activity.ts`.
export default async function ActivityPageRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildActivityPage(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return <ActivityClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} />
}
