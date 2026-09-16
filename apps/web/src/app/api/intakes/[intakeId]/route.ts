import { abandonIntake, readIntake, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The whole conversation: its messages in order, the draft if there is one, the step log if accept
 *  has run, and how many turns are left. The drawer polls this while the daemon is thinking (M59
 *  R16) -- polling and not SSE, because the event stream is per workspace and a conversation has
 *  none until it creates one. */
export async function GET(_request: Request, context: { params: Promise<{ intakeId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { intakeId } = await context.params
  const result = await readIntake(intakeId)
  return result.ok
    ? Response.json({ intake: result.value })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}

export async function DELETE(_request: Request, context: { params: Promise<{ intakeId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { intakeId } = await context.params
  const result = await abandonIntake(intakeId, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
