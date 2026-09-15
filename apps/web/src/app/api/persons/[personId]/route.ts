import { deletePerson } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R13/R15: DELETE deletes the PERSON -- every seat, every run, every memory. The confirmation
 *  that says how many projects that is lives in the UI (`DeletePersonButton`), which reads the same
 *  footprint this verb reports back. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  return orgControlResponse(() => deletePerson(personId, gate.principal ?? undefined))
}
