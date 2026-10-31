import { fillLeadRosterFromIntake, refusalText } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Project screen's "Use the people proposed when the project was created": an empty roster is
 *  filled with one person of each persona the creating conversation proposed -- the CLI's
 *  `set-lead --roster-from-intake` (`fillLeadRosterFromIntake` owns every refusal and its
 *  sentence). Answers the roster it wrote. */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const result = await fillLeadRosterFromIntake(workspaceId)
  return result.ok
    ? Response.json({ ok: true, roster: result.value.roster })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
