import { acceptIntake, refusalText } from '@slave-of-ai/control'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'
const BODY_ERROR = 'the body must be { draft: <the project details> }'

/**
 * M59 R18: the button. The body is the edited draft, not the stored one -- a person may change any
 * field on the card, and `acceptIntake` re-validates the result against the schema and against the
 * facts (R8), so an edit cannot name a repository the conversation never saw.
 *
 * `initRepository` runs in this process for a `repo.mode: 'new'` draft: one `mkdir`, one `git
 * init`, one README and one commit, inside a directory this request created, under a path the
 * operator chose. The precedent is the paragraph in the messages route above.
 */
export async function POST(request: Request, context: { params: Promise<{ intakeId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { intakeId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || (body as { draft?: unknown }).draft === undefined) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  const result = await acceptIntake(intakeId, (body as { draft: unknown }).draft, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, workspaceId: result.value.workspaceId })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
