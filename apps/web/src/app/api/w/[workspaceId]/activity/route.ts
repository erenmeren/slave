import { z } from 'zod'
import { parseActivityFilters } from '../../../../../lib/activityFilters'
import { buildActivityHistory } from '../../../../../server/activity'

// Reads the live database on every hit; a cached page of the activity log is a lie about a live
// system (same reasoning as the overview route).
export const dynamic = 'force-dynamic'

const positiveInt = z.coerce.number().int().positive()

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const url = new URL(request.url)

  const parsedFilters = parseActivityFilters(url.searchParams)
  if (!parsedFilters.ok) {
    return Response.json({ error: parsedFilters.error }, { status: 400 })
  }

  const rawBefore = url.searchParams.get('before')
  const beforeResult = rawBefore === null ? undefined : positiveInt.safeParse(rawBefore)
  if (beforeResult !== undefined && !beforeResult.success) {
    return Response.json({ error: 'before must be a positive integer' }, { status: 400 })
  }

  const rawLimit = url.searchParams.get('limit')
  const limitResult = rawLimit === null ? undefined : positiveInt.safeParse(rawLimit)
  if (limitResult !== undefined && !limitResult.success) {
    return Response.json({ error: 'limit must be a positive integer' }, { status: 400 })
  }

  const page = await buildActivityHistory(workspaceId, parsedFilters.filters, {
    ...(beforeResult?.data !== undefined ? { before: beforeResult.data } : {}),
    ...(limitResult?.data !== undefined ? { limit: limitResult.data } : {}),
  })
  if (page === null) return new Response(`no workspace with id ${workspaceId}`, { status: 404 })
  return Response.json(page)
}
