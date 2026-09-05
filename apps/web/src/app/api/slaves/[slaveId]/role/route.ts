import { setSlaveRole } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "role": string }'

/** `SlaveRowActions`'s role write (M23 D2) -- `setSlaveRole` refuses while the slave holds a
 *  live run, surfaced verbatim by `orgControlResponse`. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { slaveId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const { role } = body as { role?: unknown }
  if (typeof role !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  return orgControlResponse(() => setSlaveRole(slaveId, role, gate.principal ?? undefined))
}
