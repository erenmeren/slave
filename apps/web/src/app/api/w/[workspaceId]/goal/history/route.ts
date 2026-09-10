import { buildGoalHistory } from '../../../../../../server/goal'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Every version of this project's goal, newest first, each with the line diff against the version
 * it replaced (M40 §6) -- what `GoalPanel`'s history list renders.
 *
 * A READ, so no control verb envelope and no `workspaceControlResponse`: that shell exists to
 * translate a `Result` refusal into a 409, and the one thing this can be asked that has no answer
 * is a workspace that does not exist. The builder returns `null` for it and this returns 404, the
 * same shape the Supervisor's own read route uses.
 *
 * NOT gated on `archivedRefusal`: an archived project's history is still its history, and reading
 * it changes nothing. Only the WRITE beside it (`POST ../goal`) is refused while archived.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const history = await buildGoalHistory(workspaceId)
  if (history === null) return Response.json({ error: 'no such workspace' }, { status: 404 })

  return Response.json(history)
}
