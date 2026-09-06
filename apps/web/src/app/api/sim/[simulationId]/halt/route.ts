import { haltSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ reason: z.string().min(1).default('operator') })

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const text = await request.text()
  let raw: unknown = {}
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return Response.json({ error: 'the body must be JSON: { "reason"?: string }' }, { status: 400 })
    }
  }
  const parsed = body.safeParse(raw)
  if (!parsed.success) return Response.json({ error: 'the body must be { reason?: string }' }, { status: 400 })
  const { simulationId } = await context.params
  return simControlResponse(() => haltSimulation(simulationId, parsed.data.reason, gate.principal ?? undefined))
}
