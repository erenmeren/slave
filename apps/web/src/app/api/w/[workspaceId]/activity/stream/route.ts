import { parseFromSeq } from '../../../../../../server/fromSeq'
import { createEventSse } from '../../../../../../server/sse'
import { eventMatchesFilters, parseActivityFilters } from '../../../../../../lib/activityFilters'

export const dynamic = 'force-dynamic'

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

  // EventSource sends Last-Event-ID on reconnect; ?from covers manual resumption.
  const fromSeq = parseFromSeq(request.headers.get('last-event-id') ?? url.searchParams.get('from'))

  const connectionString = process.env['DATABASE_URL'] ?? ''
  if (connectionString === '') return new Response('DATABASE_URL is not set', { status: 500 })

  return createEventSse({
    workspaceId,
    fromSeq,
    connectionString,
    filter: (event) =>
      eventMatchesFilters(
        { slaveId: event.slaveId ?? null, taskId: event.taskId ?? null, type: event.type },
        parsedFilters.filters,
      ),
  })
}
