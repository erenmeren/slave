import { clearHalt } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Retract a safety halt from the header's `Clear halt` button (M57 R14c).
 *
 * There was no web route for this at all before M57 -- `clear-halt` was a CLI case and nothing
 * else -- and the header's halted state has to be reversible from the same place it is entered
 * from, or the emergency stop is a one-way door in the UI. `clearHalt` is the control function
 * that case's body moved into; the CLI calls the same one.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  return workspaceControlResponse(workspaceId, () => clearHalt(workspaceId))
}
