import { removeTaskDependency } from '@slave-of-ai/control'
import { taskControlResponse } from '../../../../../../../../server/taskControlRoute'
import { archivedRefusal } from '../../../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A task dependency edit is a project write (M27 §3.3, fix round 1 spec gap R12): `archivedRefusal`
 *  runs before `taskControlResponse`, which has no workspace-archived check of its own (it 404s a
 *  task outside this workspace, not an archived one). */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string; dependsOnTaskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId, dependsOnTaskId } = await context.params
  const archived = await archivedRefusal(workspaceId)
  if (archived !== null) return archived
  return taskControlResponse(workspaceId, taskId, () =>
    removeTaskDependency(taskId, dependsOnTaskId, 'web operator', gate.principal ?? undefined),
  )
}
