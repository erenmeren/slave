import { z } from 'zod'
import { setLifecycle } from '@slave-of-ai/control'
import { SLAVE_LIFECYCLES } from '@slave-of-ai/domain'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The three there are, off the domain's own list -- a fourth member is accepted here the moment it
 *  exists, and a typo never is. */
const bodySchema = z.object({ lifecycle: z.enum(SLAVE_LIFECYCLES) })

const BODY_ERROR = `the body must be { "lifecycle": one of ${SLAVE_LIFECYCLES.join(' | ')} }`

/**
 * A person moves a worker between lifecycles (M50 R4) -- the only path that does, and deliberately
 * human-only: there is no Supervisor action for it and no automatic caller anywhere.
 *
 * What the verb refuses -- a live run, and `permanent` for a worker on no company roster -- is left
 * to the verb, so the reason an operator reads here is the reason the CLI reads too. A move to the
 * lifecycle a worker already has is an `ok` with no event, so this route is safely idempotent.
 */
export async function POST(
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
    setLifecycle(slaveId, body.data.lifecycle, gate.principal ?? undefined),
  )
}
