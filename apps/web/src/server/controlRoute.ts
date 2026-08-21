import { prisma } from '@ai-team-os/db/client'
import { refusalText, type ControlRefusal } from '@ai-team-os/control'
import type { Result } from '@ai-team-os/domain'

/** Route shell: 404 unless the run exists in this workspace, 409 on a control refusal. */
export async function runControlResponse(
  workspaceId: string,
  runId: string,
  operate: () => Promise<Result<void, ControlRefusal>>,
): Promise<Response> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { task: { select: { workspaceId: true } } },
  })
  if (run === null || run.task.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such run in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
