import { setWorkspaceProvider, type ProviderKind } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  // `'provider' in body` rather than a truthiness check: `null` is a real instruction here ("this
  // workspace has no configured default"), and an OMITTED key is a malformed body. Collapsing the
  // two would make a typo in the field name read as "clear the provider".
  if (typeof body !== 'object' || body === null || !('provider' in body)) {
    return Response.json({ error: 'the body must be { "provider": string | null }' }, { status: 400 })
  }
  const provider = (body as { provider: unknown }).provider
  if (provider !== null && typeof provider !== 'string') {
    return Response.json({ error: 'the body must be { "provider": string | null }' }, { status: 400 })
  }
  // The STRING is handed on unvalidated: `setWorkspaceProvider` owns the `invalid_provider`
  // refusal and its verbatim text, and a second validator here would be a second place for the
  // list of kinds to go stale.
  return workspaceControlResponse(workspaceId, () =>
    setWorkspaceProvider(workspaceId, provider as ProviderKind | null, gate.principal ?? undefined),
  )
}
