import { setProfileOverrides } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { actorName, requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Edits fields of a persona's profile (`setProfileOverrides`): `{ "patch": { <field>: text or
 *  lines } }`, the Workflow among them. The control layer checks the fields and their limits and
 *  re-renders the profile a session is given. Answers the fields now edited. */
export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || !('patch' in body) || typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
    return Response.json({ error: 'the body must be { "patch": { <profile field>: … } }' }, { status: 400 })
  }
  const { patch } = body
  return controlResponse(() => setProfileOverrides(templateId, patch, actorName(gate.principal)))
}
