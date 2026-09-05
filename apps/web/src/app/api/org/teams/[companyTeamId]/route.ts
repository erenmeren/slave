import { deleteCompanyTeam } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `TeamBlock`'s delete of a department template (M25 §4.3; M27 §5). `deleteCompanyTeam` now
 *  deletes the template WITH its catalog slaves -- refusing only on an unknown `companyTeamId`,
 *  not on the template still having members. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ companyTeamId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companyTeamId } = await context.params
  return orgControlResponse(() => deleteCompanyTeam(companyTeamId, gate.principal ?? undefined))
}
