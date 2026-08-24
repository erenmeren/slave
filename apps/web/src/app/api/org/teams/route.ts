import { addCompanyTeam } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "companyId": string, "name": string }' }, { status: 400 })
  }
  const { companyId, name } = body as { companyId?: unknown; name?: unknown }
  if (typeof companyId !== 'string' || typeof name !== 'string') {
    return Response.json({ error: 'the body must be { "companyId": string, "name": string }' }, { status: 400 })
  }
  return orgControlResponse(() => addCompanyTeam(companyId, name))
}
