import { createSimulationSse } from '../../../../../server/simulationEvents'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  return createSimulationSse({ simulationId })
}
