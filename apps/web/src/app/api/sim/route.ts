import { createSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../server/simControlRoute'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ companyId: z.string().min(1), name: z.string().min(1), policy: z.enum(['A', 'B']), sector: z.string().default('trade'), seed: z.number().int().optional() })

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { companyId, name, policy: "A" | "B", sector?, seed? }' }, { status: 400 })
  const { companyId, name, policy, sector, seed } = parsed.data
  return simControlResponse(() => createSimulation({ companyId, name, sector: sector as 'trade', policy, ...(seed !== undefined ? { seed } : {}) }, gate.principal ?? undefined))
}
