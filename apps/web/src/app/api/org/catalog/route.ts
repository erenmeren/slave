import { parseCatalogFilters } from '../../../../lib/catalogFilters'
import { listWorkforceCatalogPage } from '../../../../server/org'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Workforce Catalog, filtered and PAGED (M46 R6, M55 R3). A GET with the seven params
 *  `catalogFilters.ts` parses, plus an opaque `?cursor=` that is the id of the last row of the page
 *  before this one. The facets come back whole so the filter menus never collapse to what is
 *  selected. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const filters = parseCatalogFilters(params)
  // A blank or absent cursor is the FIRST page, never an error: a shared link that lost its cursor
  // is a link to the top of the list, which is the honest thing to render.
  const cursor = (params.get('cursor') ?? '').trim()
  return Response.json(await listWorkforceCatalogPage(filters, cursor === '' ? {} : { cursor }))
}
