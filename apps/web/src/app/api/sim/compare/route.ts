import { compareSimulations, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `refusalStatus`'s not-found/refusal split (404 for a not-found id, 409 for everything else),
 *  but the success body is the comparison object itself, not the `{ ok: true, ... }` envelope
 *  every other control route answers with — a comparison is a read, not a command outcome. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const url = new URL(request.url)
  const a = url.searchParams.get('a')
  const b = url.searchParams.get('b')
  if (a === null || a === '' || b === null || b === '') return Response.json({ error: 'both a and b are required' }, { status: 400 })
  const result = await compareSimulations(a, b)
  if (result.ok) return Response.json(result.value)
  return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
