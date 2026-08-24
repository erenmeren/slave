import { addCompanyAgent } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json(
      { error: 'the body must be { "companyTeamId": string, "templateId": string, "name": string }' },
      { status: 400 },
    )
  }
  const { companyTeamId, templateId, name, model } = body as {
    companyTeamId?: unknown
    templateId?: unknown
    name?: unknown
    model?: unknown
  }
  if (typeof companyTeamId !== 'string' || typeof templateId !== 'string' || typeof name !== 'string') {
    return Response.json(
      { error: 'the body must be { "companyTeamId": string, "templateId": string, "name": string }' },
      { status: 400 },
    )
  }
  if (model !== undefined && typeof model !== 'string') {
    return Response.json({ error: 'model must be a string' }, { status: 400 })
  }
  return orgControlResponse(() => addCompanyAgent(companyTeamId, templateId, name, model !== undefined ? { model } : {}))
}
