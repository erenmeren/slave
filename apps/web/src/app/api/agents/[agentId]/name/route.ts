import { renameAgent } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "name": string }'

/** `AgentRowActions`'s rename write (M23 D2). A PUT, the same idiom as `permission/route.ts`:
 *  the agent's name is SET to the given value, not appended to. */
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
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  return orgControlResponse(() => renameAgent(agentId, name, gate.principal ?? undefined))
}
