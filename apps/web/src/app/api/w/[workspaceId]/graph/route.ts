import { buildGraphSnapshot } from '../../../../../server/graph'

// Reads the live database on every hit; a cached snapshot is a lie about a live system.
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const snapshot = await buildGraphSnapshot(workspaceId)
  if (snapshot === null) return new Response(`no workspace with id ${workspaceId}`, { status: 404 })
  return Response.json(snapshot)
}
