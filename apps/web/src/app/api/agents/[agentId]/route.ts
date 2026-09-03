import { deleteAgent } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

/** `AgentRowActions`'s delete write (M23 D2) -- no body: the agent IS the resource this route
 *  addresses (`agentId` from the path), the same shape `skills/assign/route.ts`'s DELETE takes
 *  for a pair. `deleteAgent` refuses while the agent carries any run history. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const { agentId } = await context.params
  return orgControlResponse(() => deleteAgent(agentId))
}
