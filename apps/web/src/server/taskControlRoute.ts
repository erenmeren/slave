import { prisma } from '@ai-team-os/db/client'
import { refusalText, type ControlRefusal } from '@ai-team-os/control'
import type { Result } from '@ai-team-os/domain'

/** Route shell: 404 unless the task exists in this workspace, 409 on a control refusal. */
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
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
