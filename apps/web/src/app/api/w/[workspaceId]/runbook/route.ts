import { z } from 'zod'
import { adoptRunbook, refusalText } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { buildRunbookPanel } from '../../../../../server/runbook'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ key: z.string() })

/**
 * This project's runbook (M48 R7).
 *
 * `GET`: the panel's own view -- what the Overview renders, and what a caller that only wants "what
 * is this project following" can read without the whole overview snapshot. `POST { key }`: adopt.
 * `DELETE`: stop following one.
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }` (the shell's own
 * comment sanctions one for a route that needs it): `adoptRunbook` answers `changed: false` when the
 * runbook asked for is the one already adopted, and that is a different sentence from "adopted" --
 * nothing was written and nothing was logged.
 *
 * Both writes go through `archivedRefusal` FIRST, because an archived project refuses every write
 * and this one before its verb runs at all.
 */
export async function GET(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const view = await buildRunbookPanel(workspaceId)
  if (view === null) return Response.json({ error: 'no such workspace' }, { status: 404 })
  return Response.json(view)
}

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { "key": string }' }, { status: 400 })
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const result = await adoptRunbook(workspaceId, parsed.data.key, { origin: 'human' }, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json({ error: refusalText(result.error), kind: result.error.kind }, { status: refusalStatus(result.error.kind) })
  }
  return Response.json({ ok: true, key: result.value.adopted?.key ?? null, changed: result.value.changed })
}

export async function DELETE(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const result = await adoptRunbook(workspaceId, null, { origin: 'human' }, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json({ error: refusalText(result.error), kind: result.error.kind }, { status: refusalStatus(result.error.kind) })
  }
  return Response.json({ ok: true, key: null, changed: result.value.changed })
}
