import { addDepartmentMember } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

const SHAPE = 'the body must be { "companyTeamId": string, "personId": string }'

/**
 * Puts an EXISTING person in a department (M58 R5). The verb it replaces created a roster row -- a
 * copy of a template with a name of its own -- and there is no such thing any more, so the body
 * names a person rather than a template and a name.
 *
 * (Task 5 replaces this route's POST with `createPerson`, which is where somebody is MADE; this one
 * keeps the department control honest in the meantime.)
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: SHAPE }, { status: 400 })
  const { companyTeamId, personId } = body as { companyTeamId?: unknown; personId?: unknown }
  if (typeof companyTeamId !== 'string' || typeof personId !== 'string') {
    return Response.json({ error: SHAPE }, { status: 400 })
  }
  return orgControlResponse(() => addDepartmentMember(companyTeamId, personId))
}
