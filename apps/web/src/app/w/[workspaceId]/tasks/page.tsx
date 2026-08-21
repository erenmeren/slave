import { buildTasksSnapshot } from '../../../../server/tasks'
import { TasksClient } from '../../../../components/TasksClient'

export const dynamic = 'force-dynamic'

export default async function TasksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildTasksSnapshot(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return <TasksClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} />
}
