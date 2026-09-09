import { z } from 'zod'
import { rejectDecision } from '@slave-of-ai/control'
import { decisionControlResponse } from '../../../../../../../../server/supervisorControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A reason is optional -- "no" is a complete answer -- so an ABSENT body is valid and only a
 *  malformed one is refused. What counts as a usable reason (trimmed, and an empty text stored as
 *  `null`) is `rejectDecision`'s own rule, left there so the CLI's `--reason` and this box behave
 *  identically. */
const bodySchema = z.object({ reason: z.string().optional() })

const BODY_ERROR = 'the body must be { "reason"?: string } or empty'

/**
 * A human says no to a pending proposal (M38 §6): the action never reaches the world, and the
 * reason -- if there is one -- is kept with the decision.
 *
 * The real `Principal` goes to the verb for the reason the sibling `approve` route gives.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; decisionId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, decisionId } = await context.params

  // Read as text first, so an ABSENT body and an unparseable one stay distinguishable: the panel's
  // Reject button with an empty box sends nothing at all, which is "no reason given", while
  // `request.json().catch(() => ({}))` would have quietly accepted a malformed body as the same
  // thing and rejected the proposal anyway.
  const text = await request.text().catch(() => '')
  let raw: unknown = {}
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return Response.json({ error: BODY_ERROR }, { status: 400 })
    }
  }
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  return decisionControlResponse(workspaceId, decisionId, () =>
    rejectDecision(decisionId, gate.principal ?? undefined, body.data.reason),
  )
}
