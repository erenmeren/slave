import { z } from 'zod'
import { setProfile } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { actorName, requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ profile: z.string().nullable() }).strict()
const BODY_ERROR = 'the body must be { "profile": string | null }'

/** A person's own instructions (`setProfile` at the person's level): the text replaces their
 *  persona's profile for them; `null` or an empty text clears it and the persona's shows again. */
export async function PUT(request: Request, context: { params: Promise<{ personId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return controlResponse(() => setProfile({ personId }, parsed.data.profile, actorName(gate.principal)))
}
