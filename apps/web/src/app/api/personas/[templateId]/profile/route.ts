import { z } from 'zod'
import { setProfile } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { actorName, requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ profile: z.string().nullable() }).strict()
const BODY_ERROR = 'the body must be { "profile": string | null }'

/** A persona's instructions as one text (`setProfile` at the persona's level) -- how a persona
 *  made by hand gets its profile. `null` or an empty text clears it. */
export async function PUT(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return controlResponse(() => setProfile({ templateId }, parsed.data.profile, actorName(gate.principal)))
}
