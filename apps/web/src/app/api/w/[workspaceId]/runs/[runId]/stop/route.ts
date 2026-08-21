import { requestStop } from '@ai-team-os/control'
import { runControlResponse } from '../../../../../../../server/controlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const { workspaceId, runId } = await context.params
  return runControlResponse(workspaceId, runId, () => requestStop(runId, 'web operator'))
}
