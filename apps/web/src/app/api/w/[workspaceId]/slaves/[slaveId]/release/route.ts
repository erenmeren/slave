import { z } from 'zod'
import { releaseWorker } from '@slave-of-ai/control'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The reason is REQUIRED and non-empty: it is stored on the worker and read on the Organization
 *  tab months later, and "released" with no sentence behind it is the row nobody can explain.
 *  `releaseWorker` itself accepts a blank one and records `released` -- this schema is the first
 *  line, not the rule. */
const bodySchema = z.object({ reason: z.string().min(1) })

const BODY_ERROR = 'the body must be { "reason": string }'

/**
 * The web's way to end an ephemeral worker's engagement (M50 R3).
 *
 * No new autonomy and no new rules: `releaseWorker` still refuses a worker that is not ephemeral,
 * one already released, and one with a live run, and it still deletes nothing. Same shell, scope
 * and actor rules as the sibling `profile` and `runtime-roles` routes -- `slaveControlResponse`
 * 404s a worker outside this workspace, which is what makes a cross-project id read back as
 * "no such slave".
 *
 * The session principal and no `origin`: the verb's default is `'human'`, which is what a person
 * clicking this really is -- a tick passes `'system'` for itself.
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
    releaseWorker(slaveId, body.data.reason, gate.principal ?? undefined),
  )
}
