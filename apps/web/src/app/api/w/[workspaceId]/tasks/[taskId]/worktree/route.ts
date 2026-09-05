import { collectTaskWorktree } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: Request, context: { params: Promise<{ workspaceId: string; taskId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  return workspaceControlResponse(workspaceId, () =>
    collectTaskWorktree(taskId, 'operator', gate.principal ?? undefined),
  )
}
