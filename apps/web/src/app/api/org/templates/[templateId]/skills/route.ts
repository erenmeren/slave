import { changeTemplateSkills, setTemplateSkills } from '@slave-of-ai/control'
import { optionalIdArray } from '../../../../../../server/idArrayField'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY = 'the body must be { "skillIds": string[] } or { "add"?: string[], "remove"?: string[] }'

/**
 * M58 R25: the persona's DEFAULT skills -- and changing them changes every person hired from this
 * persona at once, because nothing copies.
 *
 * Two bodies. `{ skillIds }` is the SET the drawer's editor sends, unchanged. `{ add, remove }` is
 * the DELTA a workforce card sends (workforce cards §3): a card never sends a whole list, so two
 * cards editing one persona at once cannot drop each other's skill.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY }, { status: 400 })
  const { skillIds, add, remove } = body as { skillIds?: unknown; add?: unknown; remove?: unknown }
  const [set, a, r] = [optionalIdArray(skillIds), optionalIdArray(add), optionalIdArray(remove)]
  if (set === 'bad' || a === 'bad' || r === 'bad') return Response.json({ error: BODY }, { status: 400 })
  if (set !== undefined) {
    if (a !== undefined || r !== undefined) return Response.json({ error: BODY }, { status: 400 })
    return orgControlResponse(() => setTemplateSkills(templateId, set))
  }
  if (a === undefined && r === undefined) return Response.json({ error: BODY }, { status: 400 })
  return orgControlResponse(() =>
    changeTemplateSkills(templateId, {
      ...(a === undefined ? {} : { add: a }),
      ...(r === undefined ? {} : { remove: r }),
    }),
  )
}
