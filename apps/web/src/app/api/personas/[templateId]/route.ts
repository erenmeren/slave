import { deleteSlaveTemplate, readPersona, refusalText } from '@slave-of-ai/control'
import { controlResponse } from '../../../../server/controlRoute'
import { requirePrincipal } from '../../../../server/principal'
import { refusalStatus } from '../../../../server/refusalStatus'

export const dynamic = 'force-dynamic'

/** One persona, whole: its profile, its default skills and how many people were hired from it. */
export async function GET(_request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const result = await readPersona(templateId)
  return result.ok ? Response.json({ persona: result.value }) : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}

/** Deletes the persona (`deleteSlaveTemplate`). The people hired from it stay, with no persona;
 *  the answer counts them. */
export async function DELETE(_request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  return controlResponse(() => deleteSlaveTemplate(templateId, gate.principal ?? undefined))
}
