import { decideCard } from '@slave-of-ai/control'
import { cardDecisionSchema } from '@slave-of-ai/domain'
import { decisionControlResponse } from '../../../../../../../../server/supervisorControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR =
  'the body must be one decision: { "kind": "send_answer" | "write_answer" | "give_work" | "give_file" | "record_decision" | "change_requirement" | "dismiss", ... }'

/** The schema's own words for what is wrong, each with the field it is about -- at most three. */
function bodyProblems(issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length === 0 ? 'the body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ')
}

/**
 * Human cards H2 (plan B D1): a person decides a question card. One route for every decision, with a
 * discriminated body; `cardDecisionSchema` is the one validator (the verb checks it again for the
 * CLI), and a body it refuses is a 400 naming the field and the schema's reason -- never a 409, which
 * is for a decision the card refuses.
 *
 * The approve route's shell: a principal first (401 in accounts mode with no session), a card in
 * another workspace reads as missing (404), and every refusal is the verb's own sentence with
 * `refusalStatus`'s status -- a card resolved meanwhile and a closed question carry the
 * "Already closed by <name> at <time>." `notice` (`settledNotice`). On success the body carries the
 * verb's outcome: the decision and the one sentence it was recorded as, which the page can show.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; decisionId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, decisionId } = await context.params

  // Read as text first, so an empty body and an unparseable one are each named (the approve route's way).
  const text = await request.text().catch(() => '')
  if (text.trim() === '') return Response.json({ error: `the body is empty; ${BODY_ERROR}` }, { status: 400 })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return Response.json({ error: `the body is not JSON; ${BODY_ERROR}` }, { status: 400 })
  }
  const parsed = cardDecisionSchema.safeParse(raw)
  if (!parsed.success) return Response.json({ error: `${BODY_ERROR}; here, ${bodyProblems(parsed.error.issues)}` }, { status: 400 })

  return decisionControlResponse(
    workspaceId,
    decisionId,
    () => decideCard(decisionId, parsed.data, gate.principal ?? undefined),
    (outcome) => ({ outcome }),
  )
}
