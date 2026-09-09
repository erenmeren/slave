import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/**
 * Route shell for a verb addressed at one `SupervisorDecision` (M38 §6): 404 unless the decision
 * exists IN THIS WORKSPACE, then `refusalStatus` on the verb's own refusal.
 *
 * The same shape and the same pre-check reason as `slaveControlResponse`: a decision belonging to
 * another project must read back exactly like one that never existed, so that an id guessed (or
 * pasted) from somewhere else tells the caller nothing about whether it is real. `approveDecision`
 * and `rejectDecision` would refuse `decision_not_found` for an unknown id anyway -- and that maps
 * to 404 through `refusalStatus` -- but they know nothing about workspaces, so without this check
 * a cross-project approve would succeed.
 *
 * `Result<unknown, ...>`, not `Result<void, ...>`, for the reason the sibling shells give: the
 * envelope is `{ ok: true }` whatever the verb returns.
 */
export async function decisionControlResponse(
  workspaceId: string,
  decisionId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const decision = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { workspaceId: true },
  })
  if (decision === null || decision.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such decision in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
