import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

/** Route shell: 404 unless the run exists in this workspace, 409 on a control refusal. */
export async function runControlResponse(
  workspaceId: string,
  runId: string,
  operate: () => Promise<Result<void, ControlRefusal>>,
): Promise<Response> {
  // `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and `agent -> team ->
  // workspace` is the only linkage such a run has to a workspace.
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { agent: { select: { team: { select: { workspaceId: true } } } } },
  })
  if (run === null || run.agent.team.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such run in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
