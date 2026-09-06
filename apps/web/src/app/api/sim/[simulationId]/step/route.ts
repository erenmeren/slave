import { stepSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({
  steps: z.number().int().positive().optional(),
  untilDay: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(1).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
})

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { steps?, untilDay?, idempotencyKey?, expectedVersion? }' }, { status: 400 })
  const { simulationId } = await context.params
  const { steps, untilDay, idempotencyKey, expectedVersion } = parsed.data
  return simControlResponse(() => stepSimulation(simulationId, {
    ...(steps !== undefined ? { steps } : {}),
    ...(untilDay !== undefined ? { untilDay } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  }, gate.principal ?? undefined))
}
