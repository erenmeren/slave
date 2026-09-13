import { z } from 'zod'
import { clearStaffingPreference, setStaffingPreference } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * One capability's staffing decision for one project (M53 R9).
 *
 * The capability is in the PATH and the decision is the whole body, because the path names the
 * resource: a PUT sets this decision and a DELETE takes it back, which is exactly the two states the
 * table expresses. In the workspace-scoped family, not an unscoped one -- M50 erratum E8's ruling,
 * and `workspaceControlResponse` 404s a project that is not there and 409s an archived one before
 * the verb runs at all.
 *
 * The body is `.strict()`, its siblings' rule for a route that is new: a caller sending a field this
 * route does not know is sending it to something, and silently ignoring it would set the wrong
 * decision with a 200.
 *
 * The capability, the template and the model are all handed on UNVALIDATED: `setStaffingPreference`
 * owns `capability_not_found`, `template_not_found`, `invalid_model` and
 * `invalid_staffing_preference` together with their verbatim sentences, and a second list of any of
 * them here is a second place for them to go stale.
 */
const bodySchema = z
  .object({ templateId: z.string().min(1).nullable().optional(), model: z.string().min(1).nullable().optional() })
  .strict()

const BODY_ERROR = 'the body must be { "templateId"?: string | null, "model"?: string | null }'

/**
 * Ask for somebody -- or for a model -- on this capability (R9).
 *
 * The session's principal, not an actor name: `setBy` lands on the ROW and
 * `staffing.preference_changed` names the person, so "asked for by X" is read off one row rather
 * than joined out of the event log. A loopback installation has no account to name and passes
 * nothing, which is the `null` the column already allowed.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string; capability: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, capability } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  // `?? null` on both halves rather than a spread: under `exactOptionalPropertyTypes` an ABSENT
  // field and a field holding `undefined` are different types, and zod's `.optional()` produces the
  // second. `setStaffingPreference` reads a null as "this half is not named", which is exactly what
  // an omitted field means -- so the two spellings collapse here rather than at the verb.
  return workspaceControlResponse(workspaceId, () =>
    setStaffingPreference(
      workspaceId,
      { capability, templateId: body.data.templateId ?? null, model: body.data.model ?? null },
      gate.principal ?? undefined,
    ),
  )
}

/**
 * Take the decision back (R9): the row is deleted and the capability returns to "nobody in
 * particular".
 *
 * No body at all, and deleting nothing is SUCCESS -- `clearStaffingPreference`'s own contract, and
 * what DELETE promises.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; capability: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, capability } = await context.params

  return workspaceControlResponse(workspaceId, () =>
    clearStaffingPreference(workspaceId, capability, gate.principal ?? undefined),
  )
}
