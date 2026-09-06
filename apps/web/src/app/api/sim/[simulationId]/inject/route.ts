import { injectExternalEvent } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ day: z.number().int().nonnegative(), event: z.unknown(), idempotencyKey: z.string().min(1).optional() })

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { day, event, idempotencyKey? }' }, { status: 400 })
  const { simulationId } = await context.params
  const { day, event, idempotencyKey } = parsed.data
  return simControlResponse(() => injectExternalEvent(simulationId, { day, event, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) }, gate.principal ?? undefined))
}
