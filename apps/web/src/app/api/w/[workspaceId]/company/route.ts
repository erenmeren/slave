import { assignCompany } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const companyId =
    typeof body === 'object' && body !== null && 'companyId' in body
      ? (body as { companyId: unknown }).companyId
      : null
  if (typeof companyId !== 'string') {
    return Response.json({ error: 'the body must be { "companyId": string }' }, { status: 400 })
  }
  return workspaceControlResponse(workspaceId, () =>
    assignCompany(workspaceId, companyId, gate.principal ?? undefined),
  )
}
