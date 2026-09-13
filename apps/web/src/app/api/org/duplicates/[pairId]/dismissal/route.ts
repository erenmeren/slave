import { setTemplateDuplicateDismissal } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A person says "I know" about one pair, or takes it back (M55 R5/R6). `POST { dismissed: boolean }`.
 *  The pair is addressed by its OWN id rather than by the two template ids, because `aId < bId` is a
 *  writer's rule and a caller should not have to know it. */
export async function POST(
  request: Request,
  context: { params: Promise<{ pairId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { pairId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const dismissed = (body as { dismissed?: unknown } | null)?.dismissed
  if (typeof dismissed !== 'boolean') {
    return Response.json({ error: 'dismissal takes { "dismissed": true } or { "dismissed": false }' }, { status: 409 })
  }
  return orgControlResponse(() => setTemplateDuplicateDismissal(pairId, dismissed, gate.principal?.userId ?? undefined))
}
