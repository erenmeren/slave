import { setProfileOverrides } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { actorName, requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * `ProfileDrawer`'s Customise mode (M46 R2): a PARTIAL patch of the profile's fields, merged into
 * whatever is already overridden. The verb validates the shape against `profileOverridesSchema` --
 * this shell only insists on an object, so the ONE definition of the shape stays in the domain.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (
    body === null ||
    typeof body !== 'object' ||
    !('patch' in body) ||
    typeof body.patch !== 'object' ||
    body.patch === null
  ) {
    return Response.json({ error: 'the body must be { "patch": { <profile field>: … } }' }, { status: 400 })
  }
  return orgControlResponse(() => setProfileOverrides(templateId, body.patch, actorName(gate.principal)))
}
