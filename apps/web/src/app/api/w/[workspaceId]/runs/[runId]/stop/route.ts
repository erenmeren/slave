import { requestStop } from '@slave-of-ai/control'
import { runControlResponse } from '../../../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, runId } = await context.params
  return runControlResponse(workspaceId, runId, () =>
    requestStop(runId, 'web operator', gate.principal ?? undefined),
  )
}
