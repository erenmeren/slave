import { updateQueuedMessage } from '@ai-team-os/control'
import { runControlResponse } from '../../../../../../../server/controlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const { workspaceId, runId } = await context.params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON with a message string' }, { status: 400 })
  }
  if (body === null || typeof body !== 'object' || !('message' in body) || typeof body.message !== 'string') {
    return Response.json({ error: 'body must be JSON with a message string' }, { status: 400 })
  }
  const message = body.message
  return runControlResponse(workspaceId, runId, () => updateQueuedMessage(runId, message))
}
