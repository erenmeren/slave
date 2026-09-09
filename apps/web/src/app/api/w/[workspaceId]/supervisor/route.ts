import { buildSupervisorView } from '../../../../../server/supervisor'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The Supervisor panel's one read (M38 §6): what is done, what is stuck, what comes next, the
 * proposals waiting on a human, the decisions taken lately, and the two settings.
 *
 * A READ, so no control verb and no `decisionControlResponse` -- that shell exists to translate a
 * `Result` refusal, and there is nothing here to refuse. The 404 is the builder's own `null`,
 * which is the one thing this route can be asked that has no answer.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const view = await buildSupervisorView(workspaceId)
  if (view === null) return Response.json({ error: 'no such workspace' }, { status: 404 })

  return Response.json(view)
}
