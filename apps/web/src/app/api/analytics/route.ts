import { analyticsDaysOf, analyticsView } from '@slave-of-ai/control'
import { textOf } from '../../../server/controlRoute'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Analytics page's one read: `?project=` one project (every project without it), `?days=` 7,
 *  30 or `all` (30 without it). */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  return Response.json({ analytics: await analyticsView({ projectId: textOf(params, 'project') ?? null, days: analyticsDaysOf(params.get('days')) }) })
}
