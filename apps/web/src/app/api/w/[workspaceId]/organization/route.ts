import { buildOrganization } from '../../../../../server/organization'
import { requirePrincipal } from '../../../../../server/principal'

// Reads the live database on every hit; a cached snapshot is a lie about a live system.
export const dynamic = 'force-dynamic'

/**
 * The Organization tab's one read (M47 R6) -- what `OrganizationClient` re-reads itself with after
 * a proposal is answered.
 *
 * A READ, so no control verb and nothing to refuse: the 404 is the builder's own `null`, which is
 * the one thing this route can be asked that has no answer. Shaped like its `supervisor` sibling,
 * whose view this one carries the pending decisions of.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const view = await buildOrganization(workspaceId)
  if (view === null) return Response.json({ error: 'no such workspace' }, { status: 404 })

  return Response.json(view)
}
