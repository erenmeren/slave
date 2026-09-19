import { buildHomeSnapshot } from '../../../server/home'
import { requirePrincipal } from '../../../server/principal'

// Reads the live database on every hit -- `useHome`'s poll and the page's own server render both
// call `buildHomeSnapshot`, and a cached answer here is a live product's list going stale under a
// stream that never stops.
export const dynamic = 'force-dynamic'

/**
 * `GET /api/home?archived=1` -- the read `useHome` polls (M61 R11), the SAME `buildHomeSnapshot`
 * `app/page.tsx` calls for the first paint, so a poll can never disagree with the page that seeded
 * it. Not workspace-scoped, like `/api/sidebar`: Home spans every project a person can see.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const includeArchived = new URL(request.url).searchParams.get('archived') === '1'
  return Response.json(await buildHomeSnapshot({ includeArchived }))
}
