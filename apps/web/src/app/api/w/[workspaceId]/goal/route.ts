import { setGoal } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const goal = typeof body === 'object' && body !== null && 'goal' in body ? (body as { goal: unknown }).goal : null
  if (typeof goal !== 'string') {
    return Response.json({ error: 'the body must be { "goal": string }' }, { status: 400 })
  }
  return workspaceControlResponse(workspaceId, () => setGoal(workspaceId, goal))
}
