import { setTemplateSkills } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R25: the persona's DEFAULT skills. A SET -- the editor sends the whole list -- and changing
 *  it changes every person hired from this persona at once, because nothing copies. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "skillIds": string[] }' }, { status: 400 })
  }
  const { skillIds } = body as { skillIds?: unknown }
  if (!Array.isArray(skillIds) || skillIds.some((one) => typeof one !== 'string')) {
    return Response.json({ error: 'the body must be { "skillIds": string[] }' }, { status: 400 })
  }
  return orgControlResponse(() => setTemplateSkills(templateId, skillIds as readonly string[]))
}
