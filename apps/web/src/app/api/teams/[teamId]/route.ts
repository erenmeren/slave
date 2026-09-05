import { deleteTeam } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `DepartmentsTable`'s delete write (M23 D3; renamed M25 §4.2) -- no body, `teamId` from the
 *  path. `deleteTeam` now deletes the department WITH its slaves and everything under them (M27
 *  §4.2); it is refused only while a live run is running on any of them. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { teamId } = await context.params
  return orgControlResponse(() => deleteTeam(teamId, gate.principal ?? undefined))
}
