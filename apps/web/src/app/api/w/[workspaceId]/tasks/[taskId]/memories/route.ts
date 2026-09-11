import { buildTaskMemories } from '../../../../../../../server/memory'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * What this task's runs were GIVEN and what the task left behind (M49 R6, plan erratum E7).
 *
 * A READ with no verb of its own, and its own route rather than a field on the board snapshot: the
 * board polls, and carrying every task's memories on every poll to fill one folded group nobody has
 * opened is exactly what the group's fetch-on-open exists to avoid.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  const view = await buildTaskMemories(workspaceId, taskId)
  if (view === null) return Response.json({ error: 'no such task' }, { status: 404 })
  return Response.json(view)
}
