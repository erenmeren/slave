import { deleteSlave } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `SlaveRowActions`'s delete write (M23 D2) -- no body: the slave IS the resource this route
 *  addresses (`slaveId` from the path), the same shape `skills/assign/route.ts`'s DELETE takes
 *  for a pair. `deleteSlave` now deletes the slave WITH its run history (M27 §4.1); it is refused
 *  only while a run is live. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { slaveId } = await context.params
  return orgControlResponse(() => deleteSlave(slaveId, gate.principal ?? undefined))
}
