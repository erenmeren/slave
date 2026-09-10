import type { Prisma } from '@slave-of-ai/db/client'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Thrown by {@link departmentFor} (and by {@link assignCompanyTx}, which is built on it) for the ONE
 * refusal it can only discover after it has already written to its caller's transaction (M34 t2 fix
 * round 2) -- the `Team_workspaceId_name_key` race a concurrent `createProjectTeam`/`renameTeam` (or
 * another department's own materialization) can still win. Every OTHER refusal in those functions is
 * decided before their first write and stays a plain returned value -- this one exists because a
 * value returned from an interactive `$transaction` callback still COMMITS everything written before
 * it; only a callback that REJECTS rolls back. Mirrors `adopt.ts`'s own `AdoptionRefused` idiom
 * (the two are not the same class: `assignCompany` catches THIS one directly, and `adoptSimulation`
 * -- which runs `assignCompanyTx` inside its own transaction -- catches both classes at the same
 * outer `catch` and unwraps either one straight to `err(error.refusal)`, rather than every
 * `assignCompanyTx` caller needing its own duplicate unwrapping).
 *
 * It lives HERE rather than in `org.ts` (M47 t2 fix round 1) only because the helper that throws it
 * moved here to be shared; `org.ts` re-exports it, so every existing importer is unaffected.
 */
export class AssignmentRefused extends Error {
  constructor(readonly refusal: ControlRefusal) {
    super('assignment refused')
    this.name = 'AssignmentRefused'
  }
}

/**
 * The project department a company team materialises into: FOUND, else ADOPTED, else created
 * (M47 t2 fix round 1, minor 4).
 *
 * One helper because there are two ways a roster worker reaches a project -- a whole company through
 * `assignCompanyTx`, and one worker at a time through `materialiseCompanySlave` -- and a project
 * staffed either way must end up with the same shape. The single-worker verb used to create
 * `Security 2` beside a hand-made `Security`, which is the one outcome this step exists to prevent.
 *
 * The three cases, in order:
 *
 * 1. **Found.** A department already bound to this company team is it, whatever it is called now: a
 *    renamed department is still this team's.
 * 2. **Adopted.** A department with this team's NAME and no company team of its own is the one an
 *    operator made by hand before the company arrived, and binding it is what keeps the roster from
 *    growing a second department for the same people. Only `companyTeamId` changes -- `workspaceId`
 *    and `name` are read off the row and are not in the update -- so this write cannot itself
 *    collide with `Team_workspaceId_name_key` (M34 t2): the index only rejects a row whose OWN
 *    `(workspaceId, name)` pair moves onto another row's, and this one does not move at all.
 * 3. **Created.** A `createProjectTeam`/`renameTeam` racing this create for the same
 *    `(workspaceId, name)` -- no lock here serialises against them -- hits the unique index instead
 *    of silently duplicating, and that arrives as {@link AssignmentRefused}.
 */
export async function departmentFor(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyTeam: { readonly id: string; readonly name: string },
): Promise<{ readonly team: { readonly id: string; readonly name: string }; readonly created: boolean }> {
  const bound = await tx.team.findFirst({ where: { workspaceId, companyTeamId: companyTeam.id } })
  if (bound !== null) return { team: bound, created: false }

  const legacy = await tx.team.findFirst({ where: { workspaceId, name: companyTeam.name, companyTeamId: null } })
  if (legacy !== null) {
    const adopted = await tx.team.update({ where: { id: legacy.id }, data: { companyTeamId: companyTeam.id } })
    return { team: adopted, created: false }
  }

  try {
    const team = await tx.team.create({ data: { workspaceId, name: companyTeam.name, companyTeamId: companyTeam.id } })
    return { team, created: true }
  } catch (error) {
    if (isUniqueConstraintViolation(error)) throw new AssignmentRefused({ kind: 'duplicate_name', name: companyTeam.name })
    throw error
  }
}
