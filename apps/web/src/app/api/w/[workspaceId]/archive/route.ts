import { archiveWorkspace, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The project Settings tab's "archive project" (M27 §3.4). Answers the footprint so the page can
 *  say what stayed on record. */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const result = await archiveWorkspace(workspaceId, gate.principal ?? undefined)
  if (result.ok) return Response.json({ ok: true, footprint: result.value.footprint })
  return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
