/**
 * Catalog Person Pool (Task 2): the pure ranking `selectPoolPerson` chooses a managed person with.
 *
 * The candidate LIST -- which template, which workspace, which seats are open -- is a database
 * read, and belongs in `packages/control`. Once read, choosing among the eligible rows is a pure
 * ordering with no I/O, so it lives here where a test can drive every tie by hand rather than by
 * seeding rows.
 */

/** One managed person eligible for `selectPoolPerson`, already filtered down to "no open seat on
 *  the target workspace" by the caller -- this module only orders what it is handed. */
export interface PoolCandidate {
  readonly personId: string
  readonly name: string
  readonly poolSlot: number
  /** How many OPEN seats this person holds, on any project. The load-balancing signal (Task 2
   *  brief): a person idle everywhere is preferred over one already spread across several
   *  projects, so one specialist does not become every project's first call. */
  readonly openSeatCount: number
}

/**
 * Orders candidates by total open-seat count ascending, then `poolSlot`, then `personId` --
 * exactly the Task 2 brief's rule, and in that order so the result is deterministic on every tie a
 * real installation can produce (two slots of one template, or two people with identical load).
 *
 * Pure and non-mutating: the caller's array is copied before it is sorted.
 */
export function rankPoolCandidates(candidates: readonly PoolCandidate[]): readonly PoolCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.openSeatCount !== b.openSeatCount) return a.openSeatCount - b.openSeatCount
    if (a.poolSlot !== b.poolSlot) return a.poolSlot - b.poolSlot
    return a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0
  })
}
