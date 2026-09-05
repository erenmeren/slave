import { prisma } from '@slave-of-ai/db/client'
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

/** Route shell: 404 unless the workspace exists, 409 on a control refusal (the M5 contract). */
export async function workspaceControlResponse(
  workspaceId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) {
    return Response.json({ error: 'no such workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
