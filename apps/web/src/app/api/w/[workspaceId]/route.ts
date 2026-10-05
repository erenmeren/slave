import { deleteWorkspace, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Lead UX design section 7: Delete a project (`deleteWorkspace`; refused while a run is live). Not
 * behind the archived guard: an archived project is one a person may well want gone. Answers what
 * was removed and the repository path that was left on disk, so the page can say so.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const result = await deleteWorkspace(workspaceId, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, name: result.value.name, repoPath: result.value.repoPath, footprint: result.value.footprint })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
