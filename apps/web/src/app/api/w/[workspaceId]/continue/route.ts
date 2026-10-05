import { continueWorkspace, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { actorName, requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Lead UX design section 7: the Project screen's Continue -- the halt retracted, every paused run
 *  asked to resume (`continueWorkspace`). Its own envelope: the page says how many runs resumed. */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const result = await continueWorkspace(workspaceId, actorName(gate.principal), gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, cleared: result.value.cleared, requested: result.value.requested, refused: result.value.refused })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
