import { setWorkspaceBudget } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (typeof body !== 'object' || body === null || !('budgetUsd' in body)) {
    return Response.json({ error: 'the body must be { "budgetUsd": number | null }' }, { status: 400 })
  }
  const budgetUsd = (body as { budgetUsd: unknown }).budgetUsd
  if (budgetUsd !== null && typeof budgetUsd !== 'number') {
    return Response.json({ error: 'the body must be { "budgetUsd": number | null }' }, { status: 400 })
  }
  // A negative or non-finite number is a REFUSAL, not a 400: `invalid_budget` carries the
  // operator-facing text, and the card shows it verbatim.
  return workspaceControlResponse(workspaceId, () =>
    setWorkspaceBudget(workspaceId, budgetUsd, gate.principal ?? undefined),
  )
}
