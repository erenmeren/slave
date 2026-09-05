import { addCompanyTeam, refusalText } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M25 Task 8: answers the new department's id, the way `POST /api/w/:id/teams` (Task 2) does --
 *  the "new department…" step of the New agent drawer needs it to place the agent it creates
 *  next without a second read. */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "companyId": string, "name": string }' }, { status: 400 })
  }
  const { companyId, name } = body as { companyId?: unknown; name?: unknown }
  if (typeof companyId !== 'string' || typeof name !== 'string') {
    return Response.json({ error: 'the body must be { "companyId": string, "name": string }' }, { status: 400 })
  }
  const result = await addCompanyTeam(companyId, name)
  return result.ok
    ? Response.json({ ok: true, id: result.value.id })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
