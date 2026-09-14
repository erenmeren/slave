import { buildSidebarTree } from '../../../server/sidebar'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The sidebar tree, refetched by `SidebarTree` on a route change and on the CURRENT workspace's
 * stream wake-up (M57 R5).
 *
 * A READ, so no control shell and no refusal to translate. It is NOT workspace-scoped: the tree
 * lists every project, which is the whole point of it, and a per-workspace route would need one
 * call per row.
 */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json(await buildSidebarTree())
}
