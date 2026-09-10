import { z } from 'zod'
import { refusalText, setGoal } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ goal: z.string() })

/**
 * Set the goal, as a new VERSION of it (M40 §4).
 *
 * Its own envelope rather than `workspaceControlResponse`'s `{ ok: true }` -- the shell's own
 * comment sanctions this for a route that needs one -- because both outcomes carry a number the
 * panel has to render:
 *
 * - success returns the `version` it wrote and that text's `sha256`, so the panel can say "goal v3
 *   saved" without a second read;
 * - a refusal returns its `kind` beside the text, so the panel can tell `goal_unchanged` (a person
 *   pressed save on the words already there -- "no change", not a failure) from every other refusal,
 *   which is a red band. Matching the refusal's SENTENCE to find that out would put the wording of
 *   `refusalText` into the browser, where a rewording would silently turn "no change" back into an
 *   error band.
 *
 * The archived guard is still `archivedRefusal`'s, called first and unchanged: an archived project
 * refuses every write, and this one before its verb runs at all.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'the body must be { "goal": string }' }, { status: 400 })
  }

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  const result = await setGoal(workspaceId, parsed.data.goal, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ ok: true, version: result.value.version, sha256: result.value.sha256 })
}
