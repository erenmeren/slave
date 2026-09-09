import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/**
 * Route shell for a verb addressed at one `Slave` (M37 t4): 404 unless the worker exists IN THIS
 * WORKSPACE, then `refusalStatus` on the verb's own refusal.
 *
 * The same shape and the same pre-check reason as `runControlResponse`/`messageControlResponse`:
 * a worker in another workspace must read back exactly like one that never existed. A `Slave` has
 * no `workspaceId` column of its own -- `slave -> team -> workspace` is its only linkage to one,
 * which is the same walk `runControlResponse` makes through the run's slave.
 *
 * `Result<unknown, ...>`, not `Result<void, ...>`: the envelope is `{ ok: true }` whatever the verb
 * returns, which is why `messageControlResponse` and `orgControlResponse` are generic too.
 */
export async function slaveControlResponse(
  workspaceId: string,
  slaveId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const slave = await prisma.slave.findUnique({
    where: { id: slaveId },
    select: { team: { select: { workspaceId: true } } },
  })
  if (slave === null || slave.team.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such slave in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
