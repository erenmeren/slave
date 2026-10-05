import { z } from 'zod'
import { changeTemplateSkills, setTemplateSkills } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const ids = z.array(z.string().min(1))
const bodySchema = z.union([
  z.object({ skillIds: ids }).strict(),
  z
    .object({ add: ids.optional(), remove: ids.optional() })
    .strict()
    .refine((body) => body.add !== undefined || body.remove !== undefined),
])
const BODY_ERROR = 'the body must be { "skillIds": string[] } or { "add"?: string[], "remove"?: string[] }'

/** A persona's default skills: the whole list (`setTemplateSkills`) or a change to it
 *  (`changeTemplateSkills`). Everybody hired from the persona has them at once. Answers the list. */
export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const body = parsed.data
  if ('skillIds' in body) return controlResponse(() => setTemplateSkills(templateId, body.skillIds))
  return controlResponse(() => changeTemplateSkills(templateId, { ...(body.add === undefined ? {} : { add: body.add }), ...(body.remove === undefined ? {} : { remove: body.remove }) }))
}
