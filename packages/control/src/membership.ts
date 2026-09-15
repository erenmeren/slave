import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * A person joins a department (R5).
 *
 * A department is OPTIONAL grouping and nothing more: joining one puts nobody on a project, and
 * `assignCompany` is what turns membership into seats. Idempotent on the composite key.
 */
export async function joinDepartment(personId: string, companyTeamId: string): Promise<Result<void, ControlRefusal>> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } })
  if (person === null) return err({ kind: 'person_not_found', personId })
  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })
  await prisma.companyTeamMember.upsert({
    where: { companyTeamId_personId: { companyTeamId, personId } },
    update: {},
    create: { companyTeamId, personId },
  })
  return ok(undefined)
}

/** And leaves it. `deleteMany` rather than `delete`, so leaving a department nobody put them in is
 *  the no-op it is rather than a thrown P2025. Seats are untouched: a person removed from a
 *  department keeps every project they are on -- membership opened those seats, it does not hold
 *  them open. */
export async function leaveDepartment(personId: string, companyTeamId: string): Promise<Result<void, ControlRefusal>> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } })
  if (person === null) return err({ kind: 'person_not_found', personId })
  await prisma.companyTeamMember.deleteMany({ where: { personId, companyTeamId } })
  return ok(undefined)
}

/** Who is in a department, by name -- the read the CLI's `person list --department` and the web's
 *  department row both make. */
export async function listDepartmentMembers(
  companyTeamId: string,
): Promise<Result<readonly { readonly personId: string; readonly name: string }[], ControlRefusal>> {
  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })
  const rows = await prisma.companyTeamMember.findMany({
    where: { companyTeamId },
    include: { person: { select: { id: true, name: true } } },
    orderBy: { person: { name: 'asc' } },
  })
  return ok(rows.map((row) => ({ personId: row.person.id, name: row.person.name })))
}
