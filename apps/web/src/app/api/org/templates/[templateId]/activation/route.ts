import { z } from 'zod'
import { setTemplateActivation } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * STRICT (fix round 1, item 4): an unknown key is a caller sending a field this route does not read,
 * and accepting it silently is how `{ "actve": true }` becomes a no-op somebody debugs twice. The
 * sibling `runtime-roles` route's `bodySchema` + `BODY_ERROR` shape, for the same reason it has one.
 */
const bodySchema = z.object({ active: z.boolean() }).strict()

const BODY_ERROR = 'the body must be { "active": boolean }'

/**
 * The Catalog row's activation toggle (M55 R2/R6). `POST { active: boolean }` -- a POST rather than
 * a PATCH because it is one whole state, not a patch of a many-field row, and it is idempotent
 * either way (`setTemplateActivation` answers `{ changed: false }` for a no-op).
 *
 * A body this route cannot read is a **400** (fix round 1, important 2), which is what every other
 * malformed body under `api/org/**` answers. 409 is the code `refusalStatus` gives a control verb
 * that DECLINED, and borrowing it for a shape check the verb never saw would tell a caller the
 * catalog refused when nothing ever reached it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() =>
    setTemplateActivation(templateId, body.data.active, gate.principal?.userId ?? undefined),
  )
}
