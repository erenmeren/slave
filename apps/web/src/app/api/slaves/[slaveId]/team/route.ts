import { moveSlave } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "teamId": string }'

/** The Slaves table's department `<select>` on a project row (M25 §4.1). */
export async function PUT(
  request: Request,
  context: { params: Promise<{ slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { slaveId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { teamId } = body as { teamId?: unknown }
  if (typeof teamId !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => moveSlave(slaveId, teamId, gate.principal ?? undefined))
}
