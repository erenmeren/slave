import { createCompany } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  const name = typeof body === 'object' && body !== null && 'name' in body ? (body as { name: unknown }).name : null
  if (typeof name !== 'string') {
    return Response.json({ error: 'the body must be { "name": string }' }, { status: 400 })
  }
  return orgControlResponse(() => createCompany(name))
}
