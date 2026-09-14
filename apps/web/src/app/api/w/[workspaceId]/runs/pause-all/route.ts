import { pauseActiveRuns } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * "Pause everything in this project" (M57 R7).
 *
 * ONE existing control function, called once: `pauseActiveRuns` is what `emergencyStop` already
 * fans out with, and it is already exported from the barrel. No new verb, no new event -- the
 * events are the `run.pause_requested` rows the per-run signal already writes.
 *
 * `category: 'human'`, not `'emergency_stop'`: this is an operator pausing work, not a guardrail
 * halting a project, and the two are different rungs of `docs/decisions/0001-pause-semantics.md`'s
 * ladder. Nothing here touches `haltedReason`.
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }`: `pauseActiveRuns`
 * returns a REPORT, and how many runs were asked and how many were already concluding is what the
 * header's own error band has to be able to say.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const report = await pauseActiveRuns(workspaceId, 'web operator', 'human')
  return Response.json({ ok: true, requested: report.requested, refused: report.refused })
}
