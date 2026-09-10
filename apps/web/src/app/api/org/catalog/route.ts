import { parseCatalogFilters } from '../../../../lib/catalogFilters'
import { listWorkforceCatalogPage } from '../../../../server/org'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Workforce Catalog, filtered (M46 R6). A GET with the five params `catalogFilters.ts`
 *  parses; the facets come back whole so the filter menus never collapse to what is selected. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const filters = parseCatalogFilters(new URL(request.url).searchParams)
  return Response.json(await listWorkforceCatalogPage(filters))
}
