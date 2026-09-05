import { isProviderKind } from '@slave-of-ai/control'
import { listModelsFor } from '../../../../../server/models'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `ModelSelect`'s source (M25 §5.3): the cached listing for one provider kind; `?refresh=1`
 *  re-reads it. */
export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { kind } = await context.params
  if (!isProviderKind(kind)) {
    return Response.json({ error: `no provider kind ${kind}` }, { status: 404 })
  }
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  const listing = await listModelsFor(kind, refresh ? { refresh: true } : undefined)
  return Response.json(listing)
}
