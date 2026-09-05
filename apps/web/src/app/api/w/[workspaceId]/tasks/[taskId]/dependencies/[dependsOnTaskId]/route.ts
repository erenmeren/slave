import { removeTaskDependency } from '@slave-of-ai/control'
import { taskControlResponse } from '../../../../../../../../server/taskControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string; dependsOnTaskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId, dependsOnTaskId } = await context.params
  return taskControlResponse(workspaceId, taskId, () =>
    removeTaskDependency(taskId, dependsOnTaskId, 'web operator', gate.principal ?? undefined),
  )
}
