import { refusalText, sendIntakeMessage } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const BODY_ERROR = 'the body must be { text: string }'

/**
 * M59 R18. THE WEB PROCESS RUNS DETECTION, inside `sendIntakeMessage`: a `stat`, a `readdir` and
 * two `git` reads of a path the operator themself named, which is the same trust `createWorkspace`
 * extends when it `stat`s a repo path and `GitProbe` extends when it runs `git rev-parse` there.
 * It does NOT call a model and does not import `@slave-of-ai/providers` -- `gate:m15-boundary`
 * keeps proving that, and R14 is why: the daemon owns every model call in this product.
 */
export async function POST(request: Request, context: { params: Promise<{ intakeId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { intakeId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || typeof (body as { text?: unknown }).text !== 'string') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const result = await sendIntakeMessage(intakeId, (body as { text: string }).text, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, seq: result.value.seq })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
