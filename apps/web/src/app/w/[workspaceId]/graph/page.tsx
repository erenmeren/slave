import { buildGraphSnapshot } from '../../../../server/graph'
import { GraphClient } from '../../../../components/graph/GraphClient'

export const dynamic = 'force-dynamic'

// Named `GraphPageRoute` rather than `GraphPage` -- `GraphSnapshot`/etc. already live in
// `server/graph.ts`, and the sibling `ActivityPageRoute` set the naming precedent.
export default async function GraphPageRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildGraphSnapshot(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return <GraphClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} />
}
