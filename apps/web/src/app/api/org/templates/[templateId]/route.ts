import { deleteSlaveTemplate } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `WorkforceCatalog`'s delete of a persona (M27 §5.1) -- no body, `templateId` from the path.
 *  M58 R1 made `Person.templateId` a `SetNull` relation, so the verb deletes NOTHING before the
 *  template row: every person hired from it keeps their name, their capabilities and their seats,
 *  and simply stops naming a persona. What comes back is how many of them that was
 *  (`personsUnlinked`). */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  return orgControlResponse(() => deleteSlaveTemplate(templateId, gate.principal ?? undefined))
}
