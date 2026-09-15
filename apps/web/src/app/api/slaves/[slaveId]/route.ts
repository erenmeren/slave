import { deletePerson } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R13/R15: this route addresses a SEAT and deletes the PERSON sitting in it -- every seat,
 *  every run, everywhere. That is the operator's own ruling (D5), and the confirmation the caller
 *  had to pass first is what makes it safe: `DeletePersonButton` states the project count. To take
 *  somebody off ONE project, `POST /api/persons/:id/unassign`. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { slaveId } = await context.params
  const seat = await prisma.slave.findUnique({ where: { id: slaveId }, select: { personId: true } })
  if (seat === null) return Response.json({ error: `no slave with id ${slaveId}` }, { status: 404 })
  return orgControlResponse(() => deletePerson(seat.personId, gate.principal ?? undefined))
}
