import { addTaskDependency } from '@slave-of-ai/control'
import { taskControlResponse } from '../../../../../../../server/taskControlRoute'
import { archivedRefusal } from '../../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A task dependency edit is a project write (M27 §3.3, fix round 1 spec gap R12): `archivedRefusal`
 *  runs before `taskControlResponse`, which has no workspace-archived check of its own (it 404s a
 *  task outside this workspace, not an archived one). */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  const archived = await archivedRefusal(workspaceId)
  if (archived !== null) return archived
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
