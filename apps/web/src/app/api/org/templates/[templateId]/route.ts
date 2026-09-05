import { deleteSlaveTemplate } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `TemplateCatalog`'s delete of a slave template (M27 §5.1) -- no body, `templateId` from the
 *  path. The verb removes its catalog slaves first (the schema has no cascade rule from
 *  `CompanySlave.template`), then the template itself; project slaves keep the role that was
 *  copied at materialization. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  return orgControlResponse(() => deleteSlaveTemplate(templateId, gate.principal ?? undefined))
}
