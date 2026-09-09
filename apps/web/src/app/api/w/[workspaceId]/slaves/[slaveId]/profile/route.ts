import { z } from 'zod'
import { setProfile } from '@slave-of-ai/control'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { actorName, requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `null` is not "absent" here: it is the explicit "clear my override", which lets the level below
 *  (the roster row, then the template) show through again. So the key must be PRESENT and the
 *  value must be a string or null -- `{}` is a body this route cannot read, not a clear. */
const bodySchema = z.object({ profile: z.union([z.string(), z.null()]) })

const BODY_ERROR = 'the body must be { "profile": string | null }'

/**
 * The web's one way to write a worker's persona (M37 §6).
 *
 * PATCH rather than PUT: this writes ONE field of the worker, beside `PUT /api/slaves/:id/role`
 * and `.../model`, which each replace their own field on a resource that has many.
 *
 * Workspace-scoped (`/w/:workspaceId/slaves/:slaveId`) unlike those older org routes, because the
 * panel writing it is a workspace surface and the read it edits (`overview.ts`'s `SlaveCardData`)
 * is workspace-scoped: a worker id from another project must read back as absent, which is what
 * `slaveControlResponse` enforces before the verb is ever called.
 *
 * Only `{ slaveId }` is ever addressed from here -- the template and roster levels of the chain
 * belong to the org catalog, which has no workspace to scope them by (spec erratum E3, the same
 * reason only a slave target emits an event).
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
    setProfile({ slaveId }, body.data.profile, actorName(gate.principal)),
  )
}
