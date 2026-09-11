import { refusalText, type ControlRefusal, type Principal } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import type { Result } from '@slave-of-ai/domain'
import { archivedRefusal } from './workspaceControlRoute'
import { refusalStatus } from './refusalStatus'
import { requirePrincipal } from './principal'

/**
 * The shell the three memory writes share (M49 R6): a session, a project that is not archived, a
 * memory that belongs to THIS project, then the verb.
 *
 * The workspace check is `taskControlRoute`'s own rule applied to a second table -- the control
 * verbs take a memory id alone and know nothing about which project's page asked, so without it
 * one project's Knowledge tab could correct another project's knowledge through a hand-typed URL.
 *
 * `archivedRefusal` runs BEFORE the verb, as every other write route does it: an archived project
 * refuses every write, and this one before its verb runs at all.
 */
export async function memoryControlResponse<T>(
  workspaceId: string,
  memoryId: string,
  operate: (principal: Principal | undefined) => Promise<Result<T, ControlRefusal>>,
  describe: (value: T) => Record<string, unknown>,
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const archived = await archivedRefusal(workspaceId)
  if (archived !== null) return archived
  if (!(await reachable(workspaceId, memoryId))) {
    return Response.json({ error: `no memory ${memoryId} on this project` }, { status: 404 })
  }
  const result = await operate(gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ ok: true, ...describe(result.value) })
}

/**
 * Is this memory one THIS project's Knowledge tab can show?
 *
 * `listMemories`' own three scopes, spelt again here because they are what the page renders: the
 * project's own rows, its company's, and those of the workers on its teams. Anything else belongs
 * to somebody else's page, and a write against it is a 404 rather than a refusal -- from here,
 * that memory does not exist.
 */
async function reachable(workspaceId: string, memoryId: string): Promise<boolean> {
  const [workspace, memory] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { companyId: true, teams: { select: { slaves: { select: { id: true } } } } },
    }),
    prisma.memory.findUnique({
      where: { id: memoryId },
      select: { workspaceId: true, companyId: true, slaveId: true },
    }),
  ])
  if (workspace === null || memory === null) return false
  if (memory.workspaceId === workspaceId) return true
  if (memory.companyId !== null && memory.companyId === workspace.companyId) return true
  return memory.slaveId !== null && workspace.teams.some((team) => team.slaves.some((slave) => slave.id === memory.slaveId))
}
