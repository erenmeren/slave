import { z } from 'zod'
import { clearSlavePermission, setSlavePermission } from '@slave-of-ai/control'
import { slaveControlResponse } from '../../../../../../../../server/slaveControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The MODE is the whole body. The kind is in the path and the worker is in the path, so there is
 * nothing else for a body to carry -- and `setSlavePermission` owns `invalid_permission_mode`'s
 * verbatim text, which is why this schema is the first line rather than the rule.
 *
 * `.strict()`, unlike its siblings in this family, and the move is the reason: the route this
 * replaced took `{ tool, mode }`, and a caller still sending that shape would otherwise have its
 * `tool` silently ignored while the PATH decided which cell was written -- the wrong cell, set with
 * a 200. A refusal is the only honest answer to a body written against a URL that no longer exists.
 */
const bodySchema = z.object({ mode: z.union([z.literal('allow'), z.literal('deny')]) }).strict()

const BODY_ERROR = 'the body must be { "mode": "allow" | "deny" }'

/**
 * One operation's answer for one worker (M52 R7).
 *
 * The kind is in the PATH and the mode is the whole body, because the path names the resource: a
 * PUT sets this cell and a DELETE takes the decision back, which is exactly the three states the
 * matrix draws. The legacy unscoped `/api/slaves/[slaveId]/permission` route is DELETED and this
 * is where it went -- `docs/ia.md` rule 2 (nothing is removed, only moved), and M50 erratum E8's
 * ruling that a verb addressed at one worker belongs in the workspace-scoped family, where
 * `slaveControlResponse` 404s a worker in another project before the verb is ever called.
 *
 * The kind is handed on UNVALIDATED: `setSlavePermission` owns `invalid_tool` and its verbatim
 * sentence, and a second list of the six here is a second place for them to go stale.
 *
 * The session's principal, not `actorName` (M52 R5, Task 3's review): `grantedBy` lands on the ROW
 * and `permission.changed` names the person, so the panel's "Granted by X on Y" is read off one
 * row rather than joined out of the event log. A loopback installation has no account to name and
 * passes nothing, which is the `null` the column already allowed.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string; slaveId: string; kind: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, slaveId, kind } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  return slaveControlResponse(workspaceId, slaveId, () =>
    setSlavePermission(slaveId, kind, body.data.mode, gate.principal ?? undefined),
  )
}

/**
 * Take the decision back: the row is deleted and the kind returns to "never asked" (M52 R5).
 *
 * No body at all, and deleting nothing is SUCCESS -- `clearSlavePermission`'s own contract, and
 * what DELETE promises. The third click of the matrix's cycle is this.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; slaveId: string; kind: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, slaveId, kind } = await context.params

  return slaveControlResponse(workspaceId, slaveId, () =>
    clearSlavePermission(slaveId, kind, gate.principal ?? undefined),
  )
}
