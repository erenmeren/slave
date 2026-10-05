import { z } from 'zod'
import { setTemplateActivation } from '@slave-of-ai/control'
import { controlResponse } from '../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ active: z.boolean() }).strict()
const BODY_ERROR = 'the body must be { "active": boolean }'

/** Offers the persona when a team is formed, or stops offering it (`setTemplateActivation`).
 *  Answers whether anything changed. */
export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return controlResponse(() => setTemplateActivation(templateId, parsed.data.active, gate.principal?.userId ?? undefined))
}
