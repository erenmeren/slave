import { collectTaskWorktree } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: Request, context: { params: Promise<{ workspaceId: string; taskId: string }> }): Promise<Response> {
  const { workspaceId, taskId } = await context.params
  return workspaceControlResponse(workspaceId, () => collectTaskWorktree(taskId, 'operator'))
}
