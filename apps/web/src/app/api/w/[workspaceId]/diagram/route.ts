import { buildDiagram, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Project screen's Diagram and Timeline views: one build as nodes, lines, sessions and steps
 *  in time, polled while something runs. `?version=N` picks a build; without it, the newest. A
 *  version that is not a whole number is a 400. Not gated on archiving: it is a read. */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const raw = new URL(request.url).searchParams.get('version')
  if (raw !== null && !/^[1-9]\d{0,5}$/u.test(raw)) return Response.json({ error: 'version must be a whole number above zero' }, { status: 400 })
  const diagram = await buildDiagram(workspaceId, raw === null ? undefined : Number(raw))
  return diagram.ok ? Response.json({ diagram: diagram.value }) : Response.json({ error: refusalText(diagram.error) }, { status: refusalStatus(diagram.error.kind) })
}
