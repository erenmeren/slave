import { cloneSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ name: z.string().min(1), policy: z.enum(['A', 'B']), seed: z.number().int().optional() })

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { name, policy: "A" | "B", seed? }' }, { status: 400 })
  const { simulationId } = await context.params
  const { name, policy, seed } = parsed.data
  return simControlResponse(() => cloneSimulation(simulationId, { name, policy, ...(seed !== undefined ? { seed } : {}) }, gate.principal ?? undefined))
}
