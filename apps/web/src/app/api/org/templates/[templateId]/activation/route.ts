import { setTemplateActivation } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The Catalog row's activation toggle (M55 R2/R6). `POST { active: boolean }` -- a POST rather than
 * a PATCH because it is one whole state, not a patch of a many-field row, and it is idempotent
 * either way (`setTemplateActivation` answers `{ changed: false }` for a no-op).
 *
 * A body that is not a boolean is a 409 through `invalid_request`, the union's existing kind: the
 * route does not invent a shape check the control layer would have to repeat.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const active = (body as { active?: unknown } | null)?.active
  if (typeof active !== 'boolean') {
    return Response.json({ error: 'activation takes { "active": true } or { "active": false }' }, { status: 409 })
  }
  return orgControlResponse(() => setTemplateActivation(templateId, active, gate.principal?.userId ?? undefined))
}
