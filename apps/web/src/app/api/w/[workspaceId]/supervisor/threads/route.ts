import { buildSupervisorThreads } from '../../../../../../server/supervisorThreads'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Supervisor panel's conversation history (M57 R9). A read, so no control shell: there is
 *  nothing here to refuse. It sits beside `GET /api/w/:id/supervisor` (the panel's decisions and
 *  settings) rather than inside it, because the two have different costs and the panel refetches
 *  them on different wake-ups. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  return Response.json(await buildSupervisorThreads(workspaceId))
}
