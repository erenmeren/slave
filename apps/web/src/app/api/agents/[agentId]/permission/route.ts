import { setAgentPermission } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "tool": string, "mode": "allow" | "deny" }'

/**
 * The Settings permission matrix's one write (M14 §5.7). A PUT, not a POST: a cell is SET to a
 * value, and re-sending the same body is the same state -- `setAgentPermission` upserts on
 * `@@unique([agentId, tool])`, so this is idempotent in the sense PUT promises.
 */
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
  const { tool, mode } = body as { tool?: unknown; mode?: unknown }
  if (typeof tool !== 'string' || (mode !== 'allow' && mode !== 'deny')) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  // The tool string is handed on unvalidated: `setAgentPermission` owns `invalid_tool` and its
  // verbatim text, and a second list here is a second place for the six to go stale.
  return orgControlResponse(() => setAgentPermission(agentId, tool, mode))
}
