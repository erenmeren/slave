import { z } from 'zod'
import { supersedeMemory } from '@slave-of-ai/control'
import { memoryControlResponse } from '../../../../../../../server/memoryControlRoute'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ title: z.string(), body: z.string() })

/**
 * A correction (M49 R2c): the old row is kept and stamped `superseded`, and the new one points
 * back at it. NOTHING is deleted, which is why this is a POST of new words rather than a PUT of
 * the old ones.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; memoryId: string }> },
): Promise<Response> {
  const { workspaceId, memoryId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'the body must be { "title": string, "body": string }' }, { status: 400 })
  }
  return memoryControlResponse(
    workspaceId,
    memoryId,
    // The workspace is the event's home, never the row's scope (final review, Important 2).
    async (principal) => supersedeMemory(memoryId, parsed.data, principal, workspaceId),
    (value) => ({ id: value.created.id, replaced: value.superseded.id }),
  )
}
