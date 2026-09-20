import { buildNeedsYou } from '../../../../../server/needsYou'
import { buildShellFacts } from '../../../../../server/shell'

// Reads the live database on every hit; a cached snapshot is a lie about a live system.
export const dynamic = 'force-dynamic'

/**
 * `NeedsYouBar`'s own refetch (M61 R7/Task 6, spec erratum E8): the Command strip is a layout-level
 * client component with no page-owned stream to ride the way the project pages do, so this route
 * is what its throttled poll hits.
 *
 * `buildNeedsYou` alone answers `[]` for an unknown workspace exactly as it does for a known one
 * with nothing waiting -- it has no 404 of its own to give. `buildShellFacts` DOES (`null` only
 * when the workspace row is gone), and this route is already one of its callers' siblings under
 * `app/api/w/[workspaceId]/*`, so it is read here too, for the existence check alone.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const facts = await buildShellFacts(workspaceId)
  if (facts === null) return new Response(`no workspace with id ${workspaceId}`, { status: 404 })
  const items = await buildNeedsYou(workspaceId)
  return Response.json(items)
}
