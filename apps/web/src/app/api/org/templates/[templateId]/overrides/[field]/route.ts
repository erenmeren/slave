import { clearProfileOverride } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../../server/orgControlRoute'
import { actorName, requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `Reset` on one field of `ProfileDrawer` (M46 R2): the field goes back to what the catalog says.
 *  A field name that is not one of the thirteen overridable ones is the verb's
 *  `unknown_profile_field`, a 409 -- not a 404, because the TEMPLATE was found and it is the field
 *  that is nonsense. The path segment is checked nowhere else: `PROFILE_OVERRIDABLE_FIELDS` in the
 *  domain is the one list, and a shell with its own copy could disagree with it. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string; field: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId, field } = await context.params
  return orgControlResponse(() => clearProfileOverride(templateId, field, actorName(gate.principal)))
}
