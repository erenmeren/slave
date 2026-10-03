import { z } from 'zod'
import { setWorkspaceLimits } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Any of the three, each optional: a patch may carry one limit or all of them. Only the JS TYPE is
 * this schema's business -- the bounds and their sentence are `setWorkspaceLimits`', refused as
 * `invalid_limit` with a 409, so the panel shows the same words the CLI prints. `runTimeoutMs` is
 * the column's own unit; the panel converts its minutes before it sends.
 */
const bodySchema = z.object({
  runTimeoutMs: z.number().optional(),
  maxConcurrentRuns: z.number().optional(),
  maxAttempts: z.number().optional(),
  questionTimeoutMs: z.number().optional(),
})

const BODY_ERROR = 'the body must be { "runTimeoutMs"?: number, "maxConcurrentRuns"?: number, "maxAttempts"?: number, "questionTimeoutMs"?: number }'

/**
 * The project's four dispatch limits (H9 F8, human cards H3): how long a run may work, how many runs
 * at once, how many attempts a task gets, and how long a run waits on an unanswered question.
 *
 * PATCH, the Supervisor settings route's reason: each write replaces some fields of a workspace
 * that has many, and an absent field means "leave it alone". `workspaceControlResponse` gives the
 * 404 and the archived guard every project write answers first, and the real `Principal` goes to
 * the verb so the `workspace.settings_changed` events name who moved the limit.
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
  // and one explicitly `undefined` are different types, and only the absent one means "leave it".
  const patch = {
    ...(body.data.runTimeoutMs === undefined ? {} : { runTimeoutMs: body.data.runTimeoutMs }),
    ...(body.data.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: body.data.maxConcurrentRuns }),
    ...(body.data.maxAttempts === undefined ? {} : { maxAttempts: body.data.maxAttempts }),
    ...(body.data.questionTimeoutMs === undefined ? {} : { questionTimeoutMs: body.data.questionTimeoutMs }),
  }
  return workspaceControlResponse(workspaceId, () => setWorkspaceLimits(workspaceId, patch, gate.principal ?? undefined))
}
