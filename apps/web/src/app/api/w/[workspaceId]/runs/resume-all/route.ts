import { resumeActiveRuns } from '../../../../../../server/runFanout'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** "Resume everything in this project" (M57 R7/R14b) -- the web's own loop over the EXISTING
 *  per-run `requestResume`, in `server/runFanout.ts`. Same envelope as its pause sibling. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const report = await resumeActiveRuns(workspaceId, 'web operator', gate.principal ?? undefined)
  return Response.json({ ok: true, requested: report.requested, refused: report.refused })
}
