import { deletePersonEverywhere, readPerson } from '@slave-of-ai/control'
import { controlResponse } from '../../../../server/controlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** One person, whole: the person detail's read model. 404 when there is nobody with that id. */
export async function GET(_request: Request, context: { params: Promise<{ personId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const person = await readPerson(personId)
  return person === null ? Response.json({ error: `no person with id ${personId}` }, { status: 404 }) : Response.json({ person })
}

/** Deletes the person with every seat, run and memory of theirs, and takes them off every roster
 *  (`deletePersonEverywhere`). Refused while a run of theirs is open. Answers what went. */
export async function DELETE(_request: Request, context: { params: Promise<{ personId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  return controlResponse(() => deletePersonEverywhere(personId, gate.principal ?? undefined))
}
