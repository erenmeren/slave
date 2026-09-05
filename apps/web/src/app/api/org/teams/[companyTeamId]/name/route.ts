import { renameCompanyTeam } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "name": string }'

/** `TeamBlock`'s inline rename of a department template (M25 §4.3). */
export async function PUT(
  request: Request,
  context: { params: Promise<{ companyTeamId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companyTeamId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => renameCompanyTeam(companyTeamId, name, gate.principal ?? undefined))
}
