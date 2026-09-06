import { deleteSimulation } from '@slave-of-ai/control'
import { simControlResponse } from '../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../server/principal'
import { buildSimulationSnapshot } from '../../../../server/simulation'
export const dynamic = 'force-dynamic'
export async function GET(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  const snapshot = await buildSimulationSnapshot(simulationId)
  return snapshot === null ? Response.json({ error: 'no such simulation' }, { status: 404 }) : Response.json(snapshot)
}
export async function DELETE(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  return simControlResponse(() => deleteSimulation(simulationId, gate.principal ?? undefined))
}
