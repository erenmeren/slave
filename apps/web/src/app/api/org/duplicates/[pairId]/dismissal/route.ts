import { z } from 'zod'
import { setTemplateDuplicateDismissal } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** STRICT, and 400 for anything it cannot read -- the activation route's reasoning, one verb over. */
const bodySchema = z.object({ dismissed: z.boolean() }).strict()

const BODY_ERROR = 'the body must be { "dismissed": boolean }'

/** A person says "I know" about one pair, or takes it back (M55 R5/R6). `POST { dismissed: boolean }`.
 *  The pair is addressed by its OWN id rather than by the two template ids, because `aId < bId` is a
 *  writer's rule and a caller should not have to know it. A pair nobody wrote is the verb's own
 *  `template_duplicate_not_found`, which `refusalStatus` maps to 404 -- not this route's business. */
export async function POST(
  request: Request,
  context: { params: Promise<{ pairId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { pairId } = await context.params
  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() =>
    setTemplateDuplicateDismissal(pairId, body.data.dismissed, gate.principal?.userId ?? undefined),
  )
}
