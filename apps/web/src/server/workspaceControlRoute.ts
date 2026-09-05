import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

/** Route shell: 404 unless the workspace exists, 409 `workspace_archived` on an archived project
 *  (M27 §3.3 -- every write route for the project answers this before the verb runs at all), 409
 *  on any other control refusal (the M5 contract). The restore route is the one exception: it
 *  bypasses this shell entirely so an archived project can still be un-archived. */
export async function workspaceControlResponse(
  workspaceId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, archivedAt: true } })
  if (workspace === null) {
    return Response.json({ error: 'no such workspace' }, { status: 404 })
  }
  if (workspace.archivedAt !== null) {
    return Response.json({ error: refusalText({ kind: 'workspace_archived', workspaceId }) }, { status: 409 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
