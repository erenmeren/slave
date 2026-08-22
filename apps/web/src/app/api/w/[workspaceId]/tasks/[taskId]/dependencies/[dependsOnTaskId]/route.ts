import { removeTaskDependency } from '@ai-team-os/control'
import { taskControlResponse } from '../../../../../../../../server/taskControlRoute'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string; dependsOnTaskId: string }> },
): Promise<Response> {
  const { workspaceId, taskId, dependsOnTaskId } = await context.params
  return taskControlResponse(workspaceId, taskId, () => removeTaskDependency(taskId, dependsOnTaskId, 'web operator'))
}
