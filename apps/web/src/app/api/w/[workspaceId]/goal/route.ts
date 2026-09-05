import { setGoal } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const goal = typeof body === 'object' && body !== null && 'goal' in body ? (body as { goal: unknown }).goal : null
  if (typeof goal !== 'string') {
    return Response.json({ error: 'the body must be { "goal": string }' }, { status: 400 })
  }
  return workspaceControlResponse(workspaceId, () => setGoal(workspaceId, goal, gate.principal ?? undefined))
}
