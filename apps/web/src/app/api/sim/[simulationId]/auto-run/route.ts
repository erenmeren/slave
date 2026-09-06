import { startAutoRun } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ everyMs: z.number().int().min(250).max(3_600_000), untilDay: z.number().int().positive() })

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { everyMs: 250-3600000, untilDay: positive integer }' }, { status: 400 })
  const { simulationId } = await context.params
  const { everyMs, untilDay } = parsed.data
  return simControlResponse(() => startAutoRun(simulationId, { everyMs, untilDay }, gate.principal ?? undefined))
}
