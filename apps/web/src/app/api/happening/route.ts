import { happeningNow } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** Home's "Happening now": the newest steps and changes of state across the projects that are not archived. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json({ lines: await happeningNow() })
}
