import { requestResume } from '@slave-of-ai/control'
import { runControlResponse } from '../../../../../../../server/controlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A malformed or absent body reads as no message — never a 500 over an optional field. */
async function readMessage(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message
    }
    return null
  } catch {
    return null
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, runId } = await context.params
  const message = await readMessage(request)
  return runControlResponse(workspaceId, runId, () =>
    requestResume(runId, message, 'web operator', gate.principal ?? undefined),
  )
}
