import { setWorkspaceIntegration } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "autoMerge": boolean }'

/**
 * Whether an approved review merges the branch and stamps the task integrated, or leaves both to a
 * person (E R7).
 *
 * PUT rather than PATCH: the body IS the whole setting, so there is nothing partial about it -- the
 * same shape the provider and budget routes take, and the same `workspaceControlResponse` shell for
 * the 404 and the archived guard every project write answers first.
 *
 * `setWorkspaceIntegration` returns how many `done` tasks are still unstamped, and this route drops
 * it: the count exists so the CLI can print the caveat where somebody is reading a terminal, while
 * the panel that dials this route re-renders from the server's next snapshot and shows the state
 * itself. Inventing a second envelope here (`{ ok: true, unintegratedDone }`) would make this the
 * one project write that does not answer `{ ok: true }`.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const body: unknown = await request.json().catch(() => null)
  if (typeof body !== 'object' || body === null || typeof (body as { autoMerge?: unknown }).autoMerge !== 'boolean') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const autoMerge = (body as { autoMerge: boolean }).autoMerge

  return workspaceControlResponse(workspaceId, () =>
    setWorkspaceIntegration(workspaceId, { autoMerge }, gate.principal ?? undefined),
  )
}
