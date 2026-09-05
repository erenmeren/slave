import { renameTeam } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "name": string }'

/** `DepartmentsTable`'s rename write (M23 D3; renamed M25 §4.2), the same PUT shape as
 *  `agents/[agentId]/name/route.ts`. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { teamId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  return orgControlResponse(() => renameTeam(teamId, name, gate.principal ?? undefined))
}
