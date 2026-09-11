import { listRunbooks } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Every runbook a project can adopt (M48 R7), key ascending -- the Workforce tab's own read, and
 *  the shape `api/org/catalog/route.ts` established: a gate, then the control verb's answer. Each
 *  row carries `workspaceCount`, which is the only "is anybody using this" a runbook has. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json(await listRunbooks())
}
