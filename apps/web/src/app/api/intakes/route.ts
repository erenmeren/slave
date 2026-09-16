import { openIntake, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../server/refusalStatus'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** M59 R18: opening the drawer opens a conversation. Nothing is spent and nothing is detected --
 *  see `openIntake` -- because most drawers are closed again. */
export async function POST(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const result = await openIntake(gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, id: result.value.id }, { status: 201 })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
