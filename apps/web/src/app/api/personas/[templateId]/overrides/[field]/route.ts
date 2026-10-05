import { clearProfileOverride } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../../server/controlRoute'
import { actorName, requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Takes one field of a persona's profile back to what the catalogue says (`clearProfileOverride`). */
export async function DELETE(_request: Request, context: { params: Promise<{ templateId: string; field: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId, field } = await context.params
  return controlResponse(() => clearProfileOverride(templateId, field, actorName(gate.principal)))
}
