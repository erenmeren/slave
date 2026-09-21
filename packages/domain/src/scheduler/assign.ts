/**
 * A seat, as the assignment question needs to see it (H2).
 *
 * Deliberately not `SchedulableSlave`: dispatch is handed a world that has ALREADY dropped the
 * seats nobody may be dispatched as, while assignment runs at task CREATION, off a plain query,
 * where a closed seat and a released person are rows the caller still holds. The two lifecycle
 * facts are carried here rather than filtered by the caller so the rule for "an open seat" lives in
 * one place -- the domain -- instead of once per writer.
 *
 * `id` is a plain string, not the branded `SlaveId`: every writer of `Task.assigneeId` reads these
 * rows straight out of Prisma and writes the value straight back into a column, and a brand round
 * trip on that path would buy nothing.
 */
export interface AssignableSeat {
  /** `Slave.id`. */
  readonly id: string
  /** The roles this seat may be DISPATCHED as -- `Slave.runtimeRoles`, never `Slave.role` (M37 §5). */
  readonly runtimeRoles: readonly string[]
  /** Does this seat hold a non-terminal run right now? */
  readonly busy: boolean
  /** `Slave.closedAt !== null` -- the seat itself is gone. */
  readonly closed: boolean
  /** `Person.releasedAt !== null` -- the seat stands, but nobody is in it. */
  readonly released: boolean
}

/**
 * Does this seat hold `role`?
 *
 * The ONE predicate assignment and dispatch share. Before it, `decide()` had this expression inline
 * and nothing else had it at all; now that a task names its holder at creation, a second copy is
 * exactly how a card comes to name one person while the run that starts belongs to another.
 *
 * An empty role list is a real state and means "cannot be dispatched": `.includes` on it is false
 * for every role, the empty string included, so a parked seat is never a holder.
 */
export function holdsRole(seat: { readonly runtimeRoles: readonly string[] }, role: string): boolean {
  return seat.runtimeRoles.includes(role)
}

/**
 * Whose task is this, from the moment it exists (H2)? Pure, total and deterministic.
 *
 * A task used to read "unassigned" until its first run started, because nothing wrote
 * `Task.assigneeId` and the board derived a holder from the runs alone. The work was always somebody's
 * -- dispatch matches a task's `requiredRole` against the role lists of the project's seats -- so this
 * answers the same question at creation time, in the same terms, and the board says the name.
 *
 * The rule, in order:
 *
 *  - only an OPEN seat: a closed one, or one whose person has been released, is nobody.
 *  - only a HOLDER of the role, by {@link holdsRole} -- the predicate dispatch itself matches on.
 *  - a free holder before a busy one. A busy holder is still named rather than skipped: a role held
 *    only by somebody mid-run is still a role this project serves (`staffedRolesForWorkspace` makes
 *    the identical distinction), and the task waits for them rather than for nobody.
 *  - among equals, the lowest id. Not because the lowest id is the right person, but because the
 *    same board planned twice must not name two different people, and nothing in this rule is a
 *    claim about workload.
 *
 * `null` means nobody on this project holds the role. That is a state a person has to see -- it is
 * what the Supervisor's `ready_unstaffed` situation is about -- and never a reason to invent a
 * holder.
 *
 * This is a FIRST answer, not the last one: `startRun` rewrites the column to whichever seat the
 * run actually went to, so the card always names who really has the work.
 */
export function chooseAssignee(requiredRole: string, seats: readonly AssignableSeat[]): string | null {
  const holders = seats
    .filter((seat) => !seat.closed && !seat.released && holdsRole(seat, requiredRole))
    .toSorted((a, b) => a.id.localeCompare(b.id))
  return holders.find((seat) => !seat.busy)?.id ?? holders[0]?.id ?? null
}
