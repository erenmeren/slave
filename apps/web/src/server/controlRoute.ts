import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/** Route shell: 404 unless the run exists in this workspace, then `refusalStatus` on the verb's
 *  own refusal -- a `run_not_found` here (the pre-check passed, the verb's own lookup then found
 *  nothing) is a race, not a client error, and 404 is still the honest answer for it. */
export async function runControlResponse(
  workspaceId: string,
  runId: string,
  operate: () => Promise<Result<void, ControlRefusal>>,
): Promise<Response> {
  // `slave -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and `slave -> team ->
  // workspace` is the only linkage such a run has to a workspace.
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    select: { slave: { select: { team: { select: { workspaceId: true } } } } },
  })
  if (run === null || run.slave.team.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such run in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
