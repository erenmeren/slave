import { prisma } from '@slave-of-ai/db/client'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * `MemberRow`'s roster removal (M27 §5.1), rebound onto people (M58 R5): a department holds
 * MEMBERS, so leaving the roster is losing every membership -- the person keeps working, keeps
 * their name and keeps every seat they hold.
 *
 * M58: the inline write below is what Task 4 replaces with `leaveDepartment`, once
 * `packages/control/src/departments.ts` exists. It is here so this route keeps working through the
 * one commit in which it does not.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  return orgControlResponse(async () => {
    const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } })
    if (person === null) return { ok: false as const, error: { kind: 'person_not_found' as const, personId } }
    await prisma.companyTeamMember.deleteMany({ where: { personId } })
    return { ok: true as const, value: undefined }
  })
}
