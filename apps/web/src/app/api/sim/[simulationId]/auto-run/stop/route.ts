import { stopAutoRun } from '@slave-of-ai/control'
import { simControlResponse } from '../../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  return simControlResponse(() => stopAutoRun(simulationId, undefined, gate.principal ?? undefined))
}
