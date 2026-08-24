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
  return orgControlResponse(() => setAgentModel(agentId, model))
}
