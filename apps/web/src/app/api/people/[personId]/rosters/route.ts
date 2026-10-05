import { z } from 'zod'
import { setPersonOnRoster } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../server/principal'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ workspaceId: z.string().min(1), listed: z.boolean() }).strict()
const BODY_ERROR = 'the body must be { "workspaceId": string, "listed": boolean }'

/** Puts the person on a lead-flow project's roster, or takes them off it (`setPersonOnRoster`).
 *  404 for a project that is not there, 409 for an archived one and for the roster's own rules. */
export async function PUT(request: Request, context: { params: Promise<{ personId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const refusal = await archivedRefusal(parsed.data.workspaceId)
  if (refusal !== null) return refusal
  return controlResponse(() => setPersonOnRoster(personId, parsed.data.workspaceId, parsed.data.listed))
}
