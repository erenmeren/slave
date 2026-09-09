import { approveDecision } from '@slave-of-ai/control'
import { decisionControlResponse } from '../../../../../../../../server/supervisorControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * A human says yes to a pending proposal (M38 §6): the action is carried out through its control
 * verb and the decision is marked approved.
 *
 * No body at all -- an approval is the whole message. The real `Principal` goes to the verb so
 * that `SupervisorDecision.resolvedByUserId` and the `supervisor.resolved` event's `userId` name
 * the person who clicked; `approveDecision`'s principal is optional only for the CLI, which has no
 * session to name (M38 t4 fix round 1). In loopback mode there is no account to name either, and
 * the verb records `null`, exactly as every other write on this surface has always done.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; decisionId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, decisionId } = await context.params

  return decisionControlResponse(workspaceId, decisionId, () =>
    approveDecision(decisionId, gate.principal ?? undefined),
  )
}
