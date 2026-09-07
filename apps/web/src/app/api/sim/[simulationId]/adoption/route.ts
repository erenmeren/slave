import { adoptionPreview, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The drawer's whole read (M33 §4): the current roster with the run's roles, the settings
 *  proposal, the model an `llm` run would carry, and the eligible workspaces -- as-is, not
 *  wrapped in `{ ok: true, ... }` the way a mutation's small value is (`simControlResponse`),
 *  since this IS the payload the drawer renders. */
export async function GET(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  const result = await adoptionPreview(simulationId)
  if (result.ok) return Response.json(result.value)
  return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
