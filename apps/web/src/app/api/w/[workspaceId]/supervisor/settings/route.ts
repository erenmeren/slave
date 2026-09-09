import { z } from 'zod'
import { setSupervisorSettings } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Both fields are optional and a patch may carry either, both, or neither -- `setSupervisorSettings`
 * writes only what actually MOVED and emits nothing when nothing did, so an empty patch is a no-op
 * rather than a malformed request.
 *
 * `profile` is nullable because `null` is a real value here and the only one that says "cleared":
 * an empty string would be indistinguishable from "leave it alone" once trimmed. The length cap is
 * the verb's (`PROFILE_MAX_CHARS`, refused as `profile_too_long`), not a second limit restated
 * here, so an operator reads the same sentence the CLI does.
 */
const bodySchema = z.object({
  enabled: z.boolean().optional(),
  profile: z.string().nullable().optional(),
})

const BODY_ERROR = 'the body must be { "enabled"?: boolean, "profile"?: string | null }'

/**
 * The two Supervisor settings a project may change (M38 §6): whether the Supervisor decides at all,
 * and the persona/house rules its decision prompt carries.
 *
 * PATCH, because each write replaces ONE field of a workspace that has many -- the same reason the
 * slave profile and runtime-role routes are PATCHes. `workspaceControlResponse` gives the 404 for
 * a project that does not exist and the archived guard every other project write answers first.
 * The real `Principal` goes to the verb so the `workspace.settings_changed` events name who
 * flipped the switch.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  // Spread rather than passed straight through: under `exactOptionalPropertyTypes` an absent field
  // and a field explicitly set to `undefined` are different types, and only the absent one means
  // "leave this alone" to the verb.
  const patch = {
    ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
    ...(body.data.profile === undefined ? {} : { profile: body.data.profile }),
  }

  return workspaceControlResponse(workspaceId, () =>
    setSupervisorSettings(workspaceId, patch, gate.principal ?? undefined),
  )
}
