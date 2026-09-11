import { verifyMemory } from '@slave-of-ai/control'
import { memoryControlResponse } from '../../../../../../../server/memoryControlRoute'

export const dynamic = 'force-dynamic'

/** A person says a candidate is true (M49 R2c). A no-op `ok` on a row that is already verified --
 *  `verifyMemory`'s own rule -- so a double click is not a refusal in front of anybody. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; memoryId: string }> },
): Promise<Response> {
  const { workspaceId, memoryId } = await context.params
  return memoryControlResponse(
    workspaceId,
    memoryId,
    // The project whose page the person is on is where this move belongs on the timeline (final
    // review, Important 2): a worker's lesson has no workspace of its own, and without this the
    // verification reached no stream at all.
    async (principal) => verifyMemory(memoryId, principal, workspaceId),
    (memory) => ({ id: memory.id }),
  )
}
