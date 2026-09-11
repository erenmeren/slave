import { z } from 'zod'
import { removeMemory } from '@slave-of-ai/control'
import { memoryControlResponse } from '../../../../../../../server/memoryControlRoute'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ reason: z.string() })

/**
 * Withdrawing a memory (M49 R2c). The row stays and keeps the reason -- `removed` is a status, not
 * a delete -- so the reason is REQUIRED here and `removeMemory` refuses an empty one; the page
 * shows that refusal rather than inventing a reason nobody gave.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; memoryId: string }> },
): Promise<Response> {
  const { workspaceId, memoryId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'the body must be { "reason": string }' }, { status: 400 })
  }
  return memoryControlResponse(
    workspaceId,
    memoryId,
    // The workspace is the event's home, never the row's scope (final review, Important 2).
    async (principal) => removeMemory(memoryId, parsed.data.reason, principal, workspaceId),
    (memory) => ({ id: memory.id }),
  )
}
