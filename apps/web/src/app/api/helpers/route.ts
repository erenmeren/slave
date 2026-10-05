import { listHelpers } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** Lead UX design sections 6.5 and 11: the catalogue of specialists a lead may call on, for the
 *  Helpers screen and a project's roster picker. A read. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json({ helpers: await listHelpers() })
}
