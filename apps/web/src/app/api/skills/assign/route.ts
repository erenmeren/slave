import { setPersonSkills } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R26: the Skills page no longer assigns -- the person panel does. This route stays as the
 *  pair-shaped write the older clients call, bound to `setPersonSkills` so there is ONE writer. */
export async function POST(request: Request): Promise<Response> {
  return write(request, 'grant')
}

export async function DELETE(request: Request): Promise<Response> {
  return write(request, 'clear')
}

async function write(request: Request, mode: 'grant' | 'clear'): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "personId": string, "skillId": string }' }, { status: 400 })
  }
  const { personId, skillId } = body as { personId?: unknown; skillId?: unknown }
  if (typeof personId !== 'string' || typeof skillId !== 'string') {
    return Response.json({ error: 'the body must be { "personId": string, "skillId": string }' }, { status: 400 })
  }
  return orgControlResponse(() => setPersonSkills(personId, { [mode]: [skillId] }))
}
