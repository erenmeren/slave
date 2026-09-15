import { assignPerson } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R15: opens a seat. `role` and `roles` are optional -- `assignPerson` defaults them from the
 *  persona, which is what makes "assign to project" one click in the panel. */
export async function POST(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "teamId": string }' }, { status: 400 })
  }
  const { teamId, role, roles } = body as { teamId?: unknown; role?: unknown; roles?: unknown }
  if (typeof teamId !== 'string' || teamId === '') {
    return Response.json({ error: 'the body must be { "teamId": string }' }, { status: 400 })
  }
  if (role !== undefined && typeof role !== 'string') {
    return Response.json({ error: 'role must be a string' }, { status: 400 })
  }
  if (roles !== undefined && (!Array.isArray(roles) || roles.some((one) => typeof one !== 'string'))) {
    return Response.json({ error: 'roles must be an array of strings' }, { status: 400 })
  }
  return orgControlResponse(() =>
    assignPerson(
      personId,
      teamId,
      {
        ...(role === undefined ? {} : { role }),
        ...(roles === undefined ? {} : { runtimeRoles: roles as readonly string[] }),
      },
      gate.principal ?? undefined,
    ),
  )
}
