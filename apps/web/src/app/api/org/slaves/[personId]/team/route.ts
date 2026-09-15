import { prisma } from '@slave-of-ai/db/client'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "companyTeamId": string }'

/**
 * The Slaves table's department `<select>` on a pooled row (M25 §4.1), rebound onto people (M58
 * R5): moving somebody between two departments of one company is leaving the one and joining the
 * other, and their seats are untouched by either.
 *
 * M58: the inline write below is what Task 4 replaces with the `leaveDepartment` +
 * `joinDepartment` pair, once `packages/control/src/departments.ts` exists. It is here so this
 * route keeps working through the one commit in which it does not.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { companyTeamId } = body as { companyTeamId?: unknown }
  if (typeof companyTeamId !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(async () => {
    const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } })
    if (person === null) return { ok: false as const, error: { kind: 'person_not_found' as const, personId } }
    const target = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true, companyId: true } })
    if (target === null) return { ok: false as const, error: { kind: 'company_team_not_found' as const, companyTeamId } }
    // Only this COMPANY's memberships move: a person in two companies' departments stays in both.
    await prisma.$transaction(async (tx) => {
      await tx.companyTeamMember.deleteMany({ where: { personId, companyTeam: { companyId: target.companyId } } })
      await tx.companyTeamMember.create({ data: { personId, companyTeamId } })
    })
    return { ok: true as const, value: undefined }
  })
}
