import { deleteTeam } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

/** `TeamsTable`'s delete write (M23 D3) -- no body, `teamId` from the path. `deleteTeam` refuses
 *  while the team still has any agent on its roster. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const { teamId } = await context.params
  return orgControlResponse(() => deleteTeam(teamId))
}
