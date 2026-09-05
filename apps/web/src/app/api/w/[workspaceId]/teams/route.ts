import { createProjectTeam, refusalText } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "name": string }'

/** `DepartmentsTable`'s "New department" form (M25 §4.2). Answers the new row's id so a caller
 *  (the CLI parity test, a later drawer) can address it without a second read. Builds its own
 *  envelope rather than `workspaceControlResponse` (it must answer the new row's id), so it calls
 *  {@link archivedRefusal} itself (fix round 1, spec gap R12): a write on an archived project
 *  answers 409 `workspace_archived` the same as every other project write. */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const archived = await archivedRefusal(workspaceId)
  if (archived !== null) return archived
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const result = await createProjectTeam(workspaceId, name, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, id: result.value.id })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
