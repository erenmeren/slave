import { LLM_INPUT_MESSAGES, createSimulation } from '@slave-of-ai/control'
import { sectors } from '@slave-of-ai/simulation'
import { z } from 'zod'
import { simControlResponse } from '../../../server/simControlRoute'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'
// M31a §5: an `llm` run needs `modelProvider`, `model` and `maxModelCostUsd` -- caught here as a
// 400 (a malformed request) rather than left to `createSimulation`'s own guard, which answers the
// same missing-cap input with a 409 refusal (a request that made sense but was declined). Both
// checks exist -- this one is the route's own contract, not a duplicate of control's -- but the
// three messages come from control's own `LLM_INPUT_MESSAGES` (fix round 1, Minor #3) so this
// text can never drift from the refusal text a caller sees when control declines the same input.
// M31b §5: `sector` is required, no default -- every sector the platform knows is the registry's
// own keys (`Object.keys(sectors)`), never a literal, so a third sector needs no change here.
const SECTOR_NAMES = Object.keys(sectors) as [string, ...string[]]
const body = z
  .object({
    companyId: z.string().min(1),
    name: z.string().min(1),
    policy: z.enum(['A', 'B']),
    sector: z.enum(SECTOR_NAMES),
    seed: z.number().int().optional(),
    decisionProvider: z.enum(['rules', 'llm']).optional(),
    modelProvider: z.enum(['claude_code', 'cursor']).optional(),
    model: z.string().min(1).optional(),
    maxModelCostUsd: z.number().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decisionProvider !== 'llm') return
    if (value.modelProvider === undefined) ctx.addIssue({ code: 'custom', message: LLM_INPUT_MESSAGES.modelProviderRequired, path: ['modelProvider'] })
    if (value.model === undefined) ctx.addIssue({ code: 'custom', message: LLM_INPUT_MESSAGES.modelRequired, path: ['model'] })
    if (value.maxModelCostUsd === undefined) ctx.addIssue({ code: 'custom', message: LLM_INPUT_MESSAGES.maxModelCostUsdPositive, path: ['maxModelCostUsd'] })
  })

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'the body must be { companyId, name, policy: "A" | "B", sector?, seed? }' }, { status: 400 })
  const { companyId, name, policy, sector, seed, decisionProvider, modelProvider, model, maxModelCostUsd } = parsed.data
  return simControlResponse(() =>
    createSimulation(
      {
        companyId, name, sector, policy,
        ...(seed !== undefined ? { seed } : {}),
        ...(decisionProvider !== undefined ? { decisionProvider } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(maxModelCostUsd !== undefined ? { maxModelCostUsd } : {}),
      },
      gate.principal ?? undefined,
    ),
  )
}
