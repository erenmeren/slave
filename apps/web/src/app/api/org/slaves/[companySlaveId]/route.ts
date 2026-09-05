import { deleteCompanySlave } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `MemberRow`'s catalog-slave delete (M27 §5.1) -- no body, `companySlaveId` from the path.
 *  Project slaves materialized from this catalog slave survive with `companySlaveId` cleared. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ companySlaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companySlaveId } = await context.params
  return orgControlResponse(() => deleteCompanySlave(companySlaveId, gate.principal ?? undefined))
}
