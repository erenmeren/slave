import { restoreWorkspace, refusalText } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Projects page card and the project Settings tab's danger zone's "restore project" (M27
 *  §3.4). Bypasses `workspaceControlResponse`'s archived guard on purpose -- that guard would
 *  refuse this route on every project it exists to un-archive. */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const result = await restoreWorkspace(workspaceId, gate.principal ?? undefined)
  if (result.ok) return Response.json({ ok: true })
  const status = result.error.kind === 'workspace_not_found' ? 404 : 409
  return Response.json({ error: refusalText(result.error) }, { status })
}
