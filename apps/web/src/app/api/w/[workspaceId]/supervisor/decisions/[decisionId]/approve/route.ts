import { z } from 'zod'
import { approveDecision } from '@slave-of-ai/control'
import { decisionControlResponse } from '../../../../../../../../server/supervisorControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** An approval is a complete message on its own, so an ABSENT body is valid and only a malformed
 *  one is refused -- the sibling `reject` route's rule, for the same reason. The one thing a body
 *  can carry is an EDITED answer (M39 §6): the words a human sends instead of the ones the
 *  Supervisor drafted. What that edit may be (an answer decision, with a draft to edit) is
 *  `approveDecision`'s own rule, left there so the CLI's `--body-file` and this box behave
 *  identically. */
const bodySchema = z.object({ body: z.string().optional() })

const BODY_ERROR = 'the body must be { "body"?: string } or empty'

/**
 * A human says yes to a pending proposal (M38 §6): the action is carried out through its control
 * verb and the decision is marked approved.
 *
 * The real `Principal` goes to the verb so that `SupervisorDecision.resolvedByUserId` and the
 * `supervisor.resolved` event's `userId` name the person who clicked; `approveDecision`'s principal
 * is optional only for the CLI, which has no session to name (M38 t4 fix round 1). In loopback mode
 * there is no account to name either, and the verb records `null`, exactly as every other write on
 * this surface has always done.
 *
 * An edit is passed only when the field is actually THERE: `body !== undefined`, not a truthiness
 * test. An empty string is a body the operator typed (and one `answerQuestion` refuses as
 * `invalid_message_body`, which is the honest answer), while an absent field means "send what the
 * Supervisor drafted" -- and folding the two together would silently send the model's words to a
 * person who had cleared the box.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; decisionId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, decisionId } = await context.params

  // Read as text first, so an ABSENT body and an unparseable one stay distinguishable -- the same
  // reasoning (and the same code) the `reject` route beside it carries.
  const text = await request.text().catch(() => '')
  let raw: unknown = {}
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return Response.json({ error: BODY_ERROR }, { status: 400 })
    }
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const edited = parsed.data.body

  return decisionControlResponse(workspaceId, decisionId, () =>
    approveDecision(decisionId, gate.principal ?? undefined, edited === undefined ? undefined : { body: edited }),
  )
}
