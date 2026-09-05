import { addCompanySlave, type ProviderKind } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json(
      { error: 'the body must be { "companyTeamId": string, "templateId": string, "name": string }' },
      { status: 400 },
    )
  }
  const { companyTeamId, templateId, name, model, provider } = body as {
    companyTeamId?: unknown
    templateId?: unknown
    name?: unknown
    model?: unknown
    provider?: unknown
  }
  if (typeof companyTeamId !== 'string' || typeof templateId !== 'string' || typeof name !== 'string') {
    return Response.json(
      { error: 'the body must be { "companyTeamId": string, "templateId": string, "name": string }' },
      { status: 400 },
    )
  }
  if (model !== undefined && typeof model !== 'string') {
    return Response.json({ error: 'model must be a string' }, { status: 400 })
  }
  if (provider !== undefined && typeof provider !== 'string') {
    return Response.json({ error: 'provider must be a string' }, { status: 400 })
  }
  return orgControlResponse(() =>
    addCompanySlave(companyTeamId, templateId, name, {
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider: provider as ProviderKind } : {}),
    }),
  )
}
