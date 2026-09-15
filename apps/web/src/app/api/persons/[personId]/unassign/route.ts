import { unassignPerson } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R15/R23: "remove from this project". CLOSES the seat -- the runs and messages stay -- which
 *  is why it is its own route and not the person DELETE with a narrower scope. */
export async function POST(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "teamId": string, "reason": string }' }, { status: 400 })
  }
  const { teamId, reason } = body as { teamId?: unknown; reason?: unknown }
  if (typeof teamId !== 'string' || teamId === '') {
    return Response.json({ error: 'the body must be { "teamId": string, "reason": string }' }, { status: 400 })
  }
  const text = typeof reason === 'string' && reason.trim() !== '' ? reason : 'removed from the project'
  return orgControlResponse(() => unassignPerson(personId, teamId, { reason: text }, gate.principal ?? undefined))
}
