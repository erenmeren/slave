import { deleteCompany } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `CompanyManager`'s delete of a company (M27 §5.1) -- no body, `companyId` from the path. The
 *  verb detaches every project it was assigned to (`Workspace.companyId` cleared) before it
 *  cascades the company's department templates and their catalog slaves. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ companyId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companyId } = await context.params
  return orgControlResponse(() => deleteCompany(companyId, gate.principal ?? undefined))
}
