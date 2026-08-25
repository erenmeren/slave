import { setAgentModel } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const { agentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || !('model' in body)) {
    return Response.json({ error: 'the body must be { "model": string | null }' }, { status: 400 })
  }
  const model = (body as { model: unknown }).model
  if (model !== null && typeof model !== 'string') {
    return Response.json({ error: 'the body must be { "model": string | null }' }, { status: 400 })
  }
  // M12 Task 7: `setAgentModel` now writes a model and its provider as one pair -- this route
  // does not take a provider in its body yet (Task 13 owns that UI surface), so it can only ever
  // clear the pair, never set a real model. Passing `null` here (rather than widening this
  // route's contract) is deliberate: growing this endpoint's body is Task 13's call to make.
  return orgControlResponse(() => setAgentModel(agentId, model, null))
}
