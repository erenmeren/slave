import { listProjects } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** Lead UX design section 11: the sidebar's and Home's one read -- every project, its phase, what
 *  waits for a person and what it spent. Replaces `/api/sidebar` and `/api/home`. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json({ projects: await listProjects() })
}
