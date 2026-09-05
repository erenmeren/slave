import { setAgentModel, type ProviderKind } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "model": string | null, "provider"?: string | null }'

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { agentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || !('model' in body)) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const model = (body as { model: unknown }).model
  if (model !== null && typeof model !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  // M12 Task 13: a bare `provider` key with no value in the body reads the same as an omitted
  // one -- both mean "the operator did not name a provider" -- so `setAgentModel` still gets
  // `null` and can produce the real `model_without_provider` refusal (controller resolution 1:
  // this route must not client-side-validate that pairing away). Only a non-string, non-null
  // `provider` is a malformed request.
  const provider = 'provider' in body ? (body as { provider: unknown }).provider : null
  if (provider !== null && typeof provider !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  return orgControlResponse(() =>
    setAgentModel(agentId, model, provider as ProviderKind | null, gate.principal ?? undefined),
  )
}
