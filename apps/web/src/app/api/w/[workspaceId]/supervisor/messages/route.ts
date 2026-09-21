import { z } from 'zod'
import { listSupervisorMessages, refusalText, sendSupervisorMessage } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * One attachment as the composer hands it back (R6): the four fields
 * `POST …/supervisor/uploads` answered with, unchanged. The route does NOT re-derive them -- the
 * upload verb owns where a file landed and what kind it is, and a second opinion here would be a
 * second place for the allow-list to go stale. `sendSupervisorMessage` re-checks the PATH against
 * `docs/inbox/` anyway, because a path off a request is not evidence of anything.
 */
const attachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number(),
  kind: z.enum(['text', 'image', 'binary']),
})

const bodySchema = z.object({ text: z.string(), attachments: z.array(attachmentSchema).optional() })

const BODY_ERROR =
  'the body must be { "text": string, "attachments"?: { "path": string, "name": string, "bytes": number, "kind": "text" | "image" | "binary" }[] }'

/** What a `?limit=` that is not a number comes to: the verb's own default window. Clamped there
 *  too (1..500), so this is a parse rather than a second policy. */
function limitOf(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('limit')
  if (raw === null) return null
  const limit = Number(raw)
  return Number.isFinite(limit) ? limit : null
}

/**
 * The conversation, oldest first (R2/R8) -- the panel's read side.
 *
 * A READ, so no control shell and no archived guard: reading what was said to an archived project
 * is not a write, and a person who archived a project may still want to know what they asked it.
 * `listSupervisorMessages` answers an empty list for a project that does not exist, which is the
 * same answer `…/supervisor/threads` beside it gives, and for its reason: there is nothing here to
 * refuse.
 *
 * The rows are the control view VERBATIM -- `createdAt` is already an ISO string on it, so nothing
 * is reshaped on the way out and the panel reads the same field names the CLI does.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const limit = limitOf(request)
  return Response.json({ messages: await listSupervisorMessages(workspaceId, limit === null ? {} : { limit }) })
}

/**
 * The composer (R2/R8): one message from a person, and the reply placeholder that makes the panel
 * say "thinking" before any daemon has looked at it.
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }`, for the reason
 * `POST …/goal/request` states: the two ids are what the panel scrolls to and what it replaces
 * when the reply settles, and `kind` is how it tells one refusal from another without matching on
 * a sentence.
 *
 * The archived guard runs FIRST and unchanged: an archived project refuses every write, and a
 * message is a write that costs a model call.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  // Spread rather than passed through: under `exactOptionalPropertyTypes` an absent `attachments`
  // and one explicitly `undefined` are different types, and only the absent one means "none".
  const result = await sendSupervisorMessage(
    workspaceId,
    { text: parsed.data.text, ...(parsed.data.attachments === undefined ? {} : { attachments: parsed.data.attachments }) },
    gate.principal ?? undefined,
  )
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ ok: true, messageId: result.value.messageId, replyId: result.value.replyId })
}
