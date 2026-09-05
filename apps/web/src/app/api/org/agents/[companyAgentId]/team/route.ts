import { moveCompanyAgent } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "companyTeamId": string }'

/** The Agents table's department `<select>` on a catalog row (M25 §4.1). */
export async function PUT(
  request: Request,
  context: { params: Promise<{ companyAgentId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companyAgentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { companyTeamId } = body as { companyTeamId?: unknown }
  if (typeof companyTeamId !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => moveCompanyAgent(companyAgentId, companyTeamId, gate.principal ?? undefined))
}
