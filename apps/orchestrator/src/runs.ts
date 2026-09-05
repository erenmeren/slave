import { prisma, type Prisma } from '@slave-of-ai/db/client'

/**
 * The one place this process inserts a `SlaveRun` row (M27 final review, controller ruling R15).
 *
 * Every dispatch path -- `startRun` (`tick.ts`), `dispatchPlanning` (`planning.ts`),
 * `dispatchReview` (`review.ts`) -- reads its `Workspace` row first and checks admission against
 * that in-memory copy afterwards, which leaves a window an archive can slip through:
 *
 *   startRun reads archivedAt: null
 *                                      archiveWorkspace counts 0 live runs, sets archivedAt, commits
 *   startRun inserts the run, admitRun passes on the stale row, spawns
 *
 * and the archived project has a live slave in it, which is precisely what `archiveWorkspace`
 * promises cannot happen. Locking alone did not close it: `archiveWorkspace` takes `FOR UPDATE` on
 * the `Workspace` row, while a `SlaveRun` insert takes `FOR KEY SHARE` on the `Slave` row it
 * references -- two locks on two tables that never conflict, so the two transactions ran straight
 * through each other.
 *
 * So the insert re-reads `archivedAt` under `FOR SHARE` on the `Workspace` row, in the same
 * transaction that writes the row. `FOR SHARE` DOES conflict with archive's `FOR UPDATE`, which
 * serialises the pair: either this transaction commits its run first and `archiveWorkspace` then
 * counts it as a live run and refuses, or the archive commits first and this reads `archivedAt`
 * set and inserts nothing. The check is inside the lock that covers the row the insert races,
 * which is the guarantee spec §8 and `admitRun`'s comment state.
 *
 * `null` means "no run started" -- the same outcome every caller already has for a refused
 * admission or a lost claim race, and deliberately not an error: an archive is an operator
 * decision, not a failure of the task, and must not burn one of its attempts.
 */
export async function createRunUnlessArchived(
  workspaceId: string,
  data: Prisma.SlaveRunUncheckedCreateInput,
): Promise<{ readonly id: string } | null> {
  return prisma.$transaction(async (tx) => {
    // Raw because Prisma has no `FOR SHARE`: the lock IS the mechanism here, not an optimisation.
    const locked = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
      SELECT "archivedAt" FROM "Workspace" WHERE id = ${workspaceId} FOR SHARE
    `
    const workspace = locked[0]
    // A workspace that vanished between the caller's read and this one is as unstartable as an
    // archived one, and for the same reason: there is nothing to run in.
    if (workspace === undefined || workspace.archivedAt !== null) return null
    const run = await tx.slaveRun.create({ data })
    return { id: run.id }
  })
}
