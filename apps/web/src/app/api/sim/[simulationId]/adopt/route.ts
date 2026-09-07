import { adoptSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({
  workspaceId: z.string().min(1),
  maxConcurrentRuns: z.number().int().optional(),
  maxAttempts: z.number().int().optional(),
  applyModel: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
})

export async function POST(request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'the body must be { workspaceId, maxConcurrentRuns?, maxAttempts?, applyModel?, idempotencyKey? }' }, { status: 400 })
  }
  const { simulationId } = await context.params
  const { workspaceId, maxConcurrentRuns, maxAttempts, applyModel, idempotencyKey } = parsed.data
  return simControlResponse(() =>
    adoptSimulation(
      simulationId,
      {
        workspaceId,
        ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(applyModel !== undefined ? { applyModel } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      },
      gate.principal ?? undefined,
    ),
  )
}
