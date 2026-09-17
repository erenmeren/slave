import { prisma } from '@slave-of-ai/db/client'

/**
 * The role words this project's seats actually answer to (Task 5).
 *
 * ONE query, shared by every reader that has to agree on what "staffed" means: the planning
 * run-context's `roles` section (`runContext.ts`), first-plan conclusion validation and
 * replan-addition conclusion validation (both `planning.ts`/`replan.ts`). Before this existed, the
 * prompt's own `rolesSection` had its own copy of this query -- harmless while nothing else read
 * staffing, but a second copy is exactly how a validator and the prompt it is supposed to hold a
 * plan to drift apart: a role the prompt told the planner it could use and a role the board refuses
 * at conclusion must never be two different answers to the same question.
 *
 * Deduplicated and sorted, over every OPEN seat (`Slave.closedAt IS NULL`) whose Person has not
 * been released (`Person.releasedAt IS NULL`). Deliberately NOT filtered on whether the seat is
 * currently busy: a role held only by someone mid-run is still a role this project CAN serve, just
 * not this tick -- `world.ts`'s own `unservedRoles` makes the identical distinction for the tick
 * report, and a validator that disagreed with it would refuse a plan the very next tick was about
 * to schedule fine.
 */
export async function staffedRolesForWorkspace(workspaceId: string): Promise<readonly string[]> {
  const seats = await prisma.slave.findMany({
    where: { team: { workspaceId }, closedAt: null, person: { releasedAt: null } },
    select: { runtimeRoles: true },
  })
  return [...new Set(seats.flatMap((seat) => seat.runtimeRoles))].sort()
}
