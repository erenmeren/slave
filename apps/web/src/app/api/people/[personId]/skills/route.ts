import { z } from 'zod'
import { setPersonSkills } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const ids = z.array(z.string().min(1)).optional()
const bodySchema = z
  .object({ grant: ids, revoke: ids, clear: ids })
  .strict()
  .refine((body) => body.grant !== undefined || body.revoke !== undefined || body.clear !== undefined)
const BODY_ERROR = 'the body must name one of { "grant": string[], "revoke": string[], "clear": string[] } (skill ids)'

/** One person's adjustment to their persona's default skills (`setPersonSkills`): `grant` gives a
 *  skill, `revoke` takes one whatever the persona says, `clear` takes back either. Answers the
 *  effective skill ids. */
export async function PATCH(request: Request, context: { params: Promise<{ personId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { grant, revoke, clear } = parsed.data
  return controlResponse(() => setPersonSkills(personId, { ...(grant === undefined ? {} : { grant }), ...(revoke === undefined ? {} : { revoke }), ...(clear === undefined ? {} : { clear }) }))
}
