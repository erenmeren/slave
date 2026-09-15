import { deletePerson } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'
import { readPerson } from '../../../../server/persons'

export const dynamic = 'force-dynamic'

/** The person panel's read (M58 R23): everything `readPerson` already assembled, including closed
 *  seats and the effective skill set. DELETE is the other verb on this same URL. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const { personId } = await context.params
  const person = await readPerson(personId)
  if (person === null) return new Response(`no person with id ${personId}`, { status: 404 })
  return Response.json(person)
}

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
