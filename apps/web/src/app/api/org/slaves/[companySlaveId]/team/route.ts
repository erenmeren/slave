import { moveCompanySlave } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "companyTeamId": string }'

/** The Slaves table's department `<select>` on a catalog row (M25 §4.1). */
export async function PUT(
  request: Request,
  context: { params: Promise<{ companySlaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companySlaveId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { companyTeamId } = body as { companyTeamId?: unknown }
  if (typeof companyTeamId !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => moveCompanySlave(companySlaveId, companyTeamId, gate.principal ?? undefined))
}
