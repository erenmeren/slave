import { answerQuestion } from '@slave-of-ai/control'
import { messageControlResponse } from '../../../../../../../server/messageControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * A human answering a worker's question (M36 t3 fix round 1).
 *
 * Keyed on the QUESTION, not on the waiting run: the answer is a reply in that question's thread,
 * and the run it happens to wake is `deliverAnswers`'s decision on the next tick, not this
 * request's. Before this route the panel's "answer" button posted to `.../resume`, which resumed
 * the asker and wrote no message at all -- so the question stayed unanswered forever, was
 * re-injected into the recipient's every subsequent run, and never appeared in the thread or the
 * communication graph.
 *
 * Auth and principal handling are the resume route's, verbatim: `requirePrincipal` first, and the
 * principal passed through so the event carries who did it. No `archivedRefusal`, matching the run
 * control routes it sits beside -- archiving is refused while any run is live, and a run waiting
 * for an answer is live.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; messageId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, messageId } = await context.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON with an answer string' }, { status: 400 })
  }
  if (body === null || typeof body !== 'object' || !('answer' in body) || typeof body.answer !== 'string') {
    return Response.json({ error: 'body must be JSON with an answer string' }, { status: 400 })
  }
  const answer = body.answer

  return messageControlResponse(workspaceId, messageId, () =>
    answerQuestion(messageId, {
      body: answer,
      answeredBy: 'web operator',
      ...(gate.principal !== null ? { principal: gate.principal } : {}),
    }),
  )
}
