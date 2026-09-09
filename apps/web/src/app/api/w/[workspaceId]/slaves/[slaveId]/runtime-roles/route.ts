import { z } from 'zod'
import { setRuntimeRoles } from '@slave-of-ai/control'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { actorName, requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** An EMPTY array is a valid body, not a malformed one: "parked, cannot be dispatched" is a real
 *  state (spec §7) and `setRuntimeRoles` is the only way into and out of it. What the verb refuses
 *  -- a blank entry, a duplicate, more than `MAX_RUNTIME_ROLES` -- is left to the verb, so the
 *  reason an operator reads is the one the CLI reads too. */
const bodySchema = z.object({ roles: z.array(z.string()) })

const BODY_ERROR = 'the body must be { "roles": string[] }'

/**
 * The web's one way to change which roles a worker may be DISPATCHED as (M37 §5, §6).
 *
 * A replacement, not a merge -- the verb's own contract, mirrored by the panel's chip editor: the
 * set an operator types is the set the worker holds afterwards, so "take reviewer away" is
 * expressible. Same shell, scope and actor rules as the sibling `profile` route.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ workspaceId: string; slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, slaveId } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  return slaveControlResponse(workspaceId, slaveId, () =>
    setRuntimeRoles(slaveId, body.data.roles, actorName(gate.principal)),
  )
}
