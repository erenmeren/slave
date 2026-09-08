import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/** Route shell: 404 unless the task exists in this workspace, then `refusalStatus` on the verb's
 *  own refusal -- a `task_not_found`/`dependency_not_found` here is a race or a genuinely
 *  not-found dependency, and 404 is still the honest answer for it. */
export async function taskControlResponse(
  workspaceId: string,
  taskId: string,
  operate: () => Promise<Result<void, ControlRefusal>>,
): Promise<Response> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true },
  })
  if (task === null || task.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such task in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
