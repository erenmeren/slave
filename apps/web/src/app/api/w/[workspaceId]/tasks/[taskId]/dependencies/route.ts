import { addTaskDependency } from '@ai-team-os/control'
import { taskControlResponse } from '../../../../../../../server/taskControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
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
  return taskControlResponse(workspaceId, taskId, () => addTaskDependency(taskId, dependsOnTaskId, 'web operator'))
}
