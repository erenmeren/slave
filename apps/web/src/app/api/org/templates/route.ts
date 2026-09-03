import { createTemplate, type ProviderKind } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "name": string, "role": string }' }, { status: 400 })
  }
  const { name, role, description, defaultModel, defaultProvider } = body as {
    name?: unknown
    role?: unknown
    description?: unknown
    defaultModel?: unknown
    defaultProvider?: unknown
  }
  if (typeof name !== 'string' || typeof role !== 'string') {
    return Response.json({ error: 'the body must be { "name": string, "role": string }' }, { status: 400 })
  }
  if (description !== undefined && typeof description !== 'string') {
    return Response.json({ error: 'description must be a string' }, { status: 400 })
  }
  if (defaultModel !== undefined && typeof defaultModel !== 'string') {
    return Response.json({ error: 'defaultModel must be a string' }, { status: 400 })
  }
  if (defaultProvider !== undefined && typeof defaultProvider !== 'string') {
    return Response.json({ error: 'defaultProvider must be a string' }, { status: 400 })
  }
  return orgControlResponse(() =>
    createTemplate(name, role, {
      ...(description !== undefined ? { description } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(defaultProvider !== undefined ? { provider: defaultProvider as ProviderKind } : {}),
    }),
  )
}
