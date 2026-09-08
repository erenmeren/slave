import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/**
 * Route shell for a verb addressed at one `SlaveMessage` (M36 t3 fix round 1): 404 unless the
 * message exists IN THIS WORKSPACE, then `refusalStatus` on the verb's own refusal.
 *
 * The same shape as `runControlResponse`/`taskControlResponse`, and the same reason for the
 * pre-check: a message in another workspace must read back exactly like one that never existed --
 * the boundary `sendMessage`/`markMessageRead`/`answer.ts` all enforce on their own reads. The
 * verb's own `message_not_found` reaching here is a race, and 404 is still the honest answer.
 *
 * `Result<unknown, …>`, not `Result<void, …>`: `answerQuestion` returns the message it wrote, and
 * the envelope this shell sends is `{ ok: true }` either way (`workspaceControlResponse` is
 * generic for the same reason).
 */
export async function messageControlResponse(
  workspaceId: string,
  messageId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const message = await prisma.slaveMessage.findUnique({
    where: { id: messageId },
    select: { workspaceId: true },
  })
  if (message === null || message.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such message in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
