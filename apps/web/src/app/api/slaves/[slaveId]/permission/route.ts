import { setSlavePermission } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "tool": string, "mode": "allow" | "deny" }'

/**
 * The Settings permission matrix's one write (M14 §5.7). A PUT, not a POST: a cell is SET to a
 * value, and re-sending the same body is the same state -- `setSlavePermission` upserts on
 * `@@unique([slaveId, kind])`, so this is idempotent in the sense PUT promises.
 *
 * The body's KEY is still `tool` and now carries a `PermissionKind` string (M52 R1): the matrix
 * component sends `cell.tool`, and M52 Task 5 moves the route into the workspace-scoped family and
 * renames the field with the component in one commit.
 */
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
  const { tool, mode } = body as { tool?: unknown; mode?: unknown }
  if (typeof tool !== 'string' || (mode !== 'allow' && mode !== 'deny')) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  // The string is handed on unvalidated: `setSlavePermission` owns `invalid_tool` and its verbatim
  // text, and a second list here is a second place for the six to go stale.
  return orgControlResponse(() => setSlavePermission(slaveId, tool, mode))
}
