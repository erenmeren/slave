import { parsePeopleFilters } from '../../../lib/peopleFilters'
import { listPeoplePage } from '../../../server/persons'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** People as cards (workforce cards §1): the params `peopleFilters.ts` parses, plus an opaque
 *  `?cursor=` -- the id of the last person on the page before this one. A blank cursor is the first
 *  page, never an error (`/api/org/catalog`'s rule). */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const cursor = (params.get('cursor') ?? '').trim()
  return Response.json(await listPeoplePage(parsePeopleFilters(params), cursor === '' ? {} : { cursor }))
}
