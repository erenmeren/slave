import { addTaskDependency } from '@ai-team-os/control'
import { taskControlResponse } from '../../../../../../../server/taskControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON with a dependsOnTaskId string' }, { status: 400 })
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    !('dependsOnTaskId' in body) ||
    typeof body.dependsOnTaskId !== 'string'
  ) {
    return Response.json({ error: 'body must be JSON with a dependsOnTaskId string' }, { status: 400 })
  }
  const dependsOnTaskId = body.dependsOnTaskId
  return taskControlResponse(workspaceId, taskId, () =>
    addTaskDependency(taskId, dependsOnTaskId, 'web operator', gate.principal ?? undefined),
  )
}
