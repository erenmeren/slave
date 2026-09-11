import { readRunbook, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** One runbook, whole -- every stage with its capabilities, its gates, its retry and its
 *  escalation (M48 R7). `runbook_not_found` is a 404 by the suffix rule with no code of its own
 *  here, which is the whole point of `refusalStatus`. */
export async function GET(_request: Request, context: { params: Promise<{ key: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { key } = await context.params
  const result = await readRunbook(key)
  if (!result.ok) {
    return Response.json({ error: refusalText(result.error), kind: result.error.kind }, { status: refusalStatus(result.error.kind) })
  }
  return Response.json(result.value)
}
