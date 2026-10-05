import { projectView, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Lead UX design section 10: the Project screen's one read model, polled while something runs.
 *  Not gated on archiving: an archived project is still readable. */
export async function GET(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const view = await projectView(workspaceId)
  return view.ok ? Response.json({ project: view.value }) : Response.json({ error: refusalText(view.error) }, { status: refusalStatus(view.error.kind) })
}
