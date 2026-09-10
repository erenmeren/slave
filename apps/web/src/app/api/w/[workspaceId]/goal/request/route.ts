import { z } from 'zod'
import { refusalText, requestChange } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ request: z.string() })

/**
 * "Tell the Supervisor what changed" (M45 R3).
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }`, for the same
 * reason `POST /goal` has one: the version it wrote is a number the page renders ("goal v3
 * saved"), and the refusal's `kind` is how the page tells a `duplicate_request` -- the same words
 * submitted twice -- from a real failure without matching on a sentence.
 *
 * `goal` rides back too, so the Settings tab's document view does not need a second read to show
 * what the request composed to.
 *
 * The archived guard runs FIRST and unchanged: an archived project refuses every write.
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
    return Response.json({ error: 'the body must be { "request": string }' }, { status: 400 })
  }

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  const result = await requestChange(workspaceId, parsed.data.request, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({
    ok: true,
    version: result.value.version,
    sha256: result.value.sha256,
    goal: result.value.goal,
  })
}
