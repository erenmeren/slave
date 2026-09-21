import { NON_TERMINAL_RUN_STATUSES, type AssignableSeat } from '@slave-of-ai/domain'
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

/**
 * This project's seats, as the domain's `chooseAssignee` needs to see them (H2).
 *
 * ONE query for a whole plan, read beside `staffedRolesForWorkspace` and for the same reason: a
 * graph of three hundred tasks must not be three hundred seat reads, and the two answers a
 * conclusion gives about staffing -- "may this board be written at all" and "whose is each task" --
 * must come from one reading of the roster rather than from two that a hire could land between.
 *
 * Every seat on the project, closed and released ones included, because the rule for what counts as
 * an OPEN seat belongs to the domain rather than to each caller's `where` clause. `busy` is "holds a
 * non-terminal run", the same predicate `world.ts` builds the scheduler's own `busy` from, so the
 * seat assignment prefers and the seat dispatch picks are the same seat.
 */
export async function assignableSeatsForWorkspace(workspaceId: string): Promise<readonly AssignableSeat[]> {
  const seats = await prisma.slave.findMany({
    where: { team: { workspaceId } },
    select: {
      id: true,
      runtimeRoles: true,
      closedAt: true,
      person: { select: { releasedAt: true } },
      // `take: 1`: this asks whether the seat holds a live run at all, and counting the rest of them
      // would cost more and answer the same question.
      runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
    },
  })
  return seats.map((seat) => ({
    id: seat.id,
    runtimeRoles: seat.runtimeRoles,
    busy: seat.runs.length > 0,
    closed: seat.closedAt !== null,
    released: seat.person.releasedAt !== null,
  }))
}
