import { setAgentRole } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "role": string }'

/** `AgentRowActions`'s role write (M23 D2) -- `setAgentRole` refuses while the agent holds a
 *  live run, surfaced verbatim by `orgControlResponse`. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { agentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const { role } = body as { role?: unknown }
  if (typeof role !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  return orgControlResponse(() => setAgentRole(agentId, role, gate.principal ?? undefined))
}
