import { assignPerson, createPerson, joinDepartment, refusalText, type ProviderKind } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../server/principal'
import { refusalStatus } from '../../../../server/refusalStatus'

export const dynamic = 'force-dynamic'

/**
 * M58 R15/R24: a new SLAVE -- a person. The persona and the name are the only things asked for;
 * `companyTeamId` and `teamId` are optional, and with neither the person lands in the pool, which is
 * the operator's first ask.
 *
 * Three verbs in sequence rather than one, because they are three facts and a refusal of the second
 * or third must not undo the first: a person who exists with no department is a correct outcome, and
 * the drawer says which step was refused.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "name"?: string, "templateId"?: string }' }, { status: 400 })
  }
  const { templateId, name, model, provider, companyTeamId, teamId } = body as {
    templateId?: unknown
    name?: unknown
    model?: unknown
    provider?: unknown
    companyTeamId?: unknown
    teamId?: unknown
  }
  for (const [key, value] of Object.entries({ templateId, name, model, provider, companyTeamId, teamId })) {
    if (value !== undefined && typeof value !== 'string') {
      return Response.json({ error: `${key} must be a string` }, { status: 400 })
    }
  }
  if (templateId === undefined && name === undefined) {
    return Response.json({ error: 'a slave needs a name, or a persona to take one from' }, { status: 400 })
  }

  const created = await createPerson(
    {
      ...(templateId === undefined ? {} : { templateId: templateId as string }),
      ...(name === undefined ? {} : { name: name as string }),
      ...(model === undefined ? {} : { model: model as string }),
      ...(provider === undefined ? {} : { provider: provider as ProviderKind }),
    },
    gate.principal ?? undefined,
  )
  if (!created.ok) {
    return Response.json({ error: refusalText(created.error) }, { status: refusalStatus(created.error.kind) })
  }

  if (companyTeamId !== undefined) {
    const joined = await joinDepartment(created.value.personId, companyTeamId as string)
    if (!joined.ok) {
      return Response.json(
        { error: refusalText(joined.error), personId: created.value.personId, created: true },
        { status: refusalStatus(joined.error.kind) },
      )
    }
  }
  if (teamId !== undefined) {
    const seated = await assignPerson(created.value.personId, teamId as string, {}, gate.principal ?? undefined)
    if (!seated.ok) {
      return Response.json(
        { error: refusalText(seated.error), personId: created.value.personId, created: true },
        { status: refusalStatus(seated.error.kind) },
      )
    }
  }
  return Response.json({ personId: created.value.personId, name: created.value.name })
}
