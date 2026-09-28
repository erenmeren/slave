import { randomUUID } from 'node:crypto'
import { amendRunOutcome, isAlive } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'

/**
 * H9b (F2): THIS process's name on the runs it owns -- `SlaveRun.ownerInstance`.
 *
 * `<pid>/<uuid>`: the pid is what lets another process ask whether the owner is still alive, and
 * the uuid is what tells this process from an earlier one that had the same pid. In a container
 * the daemon gets the same pid on every restart, so a pid alone would make a restarted daemon read
 * every run its predecessor left behind as its own -- the exact runs nobody is reading.
 *
 * Minted once, at module load: one process, one owner, however many projects it serves.
 */
export const OWNER_INSTANCE = `${String(process.pid)}/${randomUUID()}`

/**
 * Whether the process that owns a run is GONE (H9b, F2) -- so the run, live child or not, has
 * nobody reading its output and nobody to conclude it.
 *
 * `false` whenever there is no evidence: a row written before the column existed (`null`), or a
 * token this process cannot parse. `false` for this process's own token. For anybody else's, the
 * owner is gone when its pid is dead -- or when its pid is THIS process's, which can only mean the
 * owner was an earlier process that had this pid (the uuid differs, or the token would be ours).
 * A live pid that is not ours is read as a live owner: the one-shot CLI `tick` and `resume-run`
 * pump their own runs beside the daemon, and killing theirs would be the second-slave hazard the
 * claim columns exist to prevent. Same-host, like every pid in this table.
 */
export function ownerGone(ownerInstance: string | null): boolean {
  if (ownerInstance === null || ownerInstance === OWNER_INSTANCE) return false
  const pid = Number(ownerInstance.split('/')[0])
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  return !isAlive(pid)
}

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
    // `ownerInstance` here, in the one insert, so there is no dispatch path that forgets it -- and
    // so a row that dies before its pid is ever recorded still names who was about to spawn it.
    const run = await tx.slaveRun.create({ data: { ...data, ownerInstance: OWNER_INSTANCE } })
    return { id: run.id }
  })
}

/**
 * Walks a run the pump concluded `succeeded` back to `failed`, because what it produced turned out
 * to be unusable -- a planning run's unparsable graph (`planning.ts`), a package run's missing or
 * malformed report (`report.ts`) -- and records why as `run.failed`.
 *
 * The `updateMany` is conditioned on `succeeded`: a run somebody stopped in the meantime is not
 * this function's to fail. M53 erratum E26: the pump wrote this run's fact when it concluded it
 * `succeeded`, and the outcome has to follow the status this just wrote.
 */
export async function failConcludedRun(
  run: { readonly id: string; readonly slaveId: string },
  workspaceId: string,
  reason: string,
): Promise<void> {
  await prisma.slaveRun.updateMany({ where: { id: run.id, status: 'succeeded' }, data: { status: 'failed' } })
  await amendRunOutcome(run.id)
  await appendEvent({
    type: 'run.failed',
    workspaceId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'system',
    payload: { reason },
  })
}

/**
 * Sends a concluded run's task back because what the run produced is unusable -- a package
 * worker's missing report (`report.ts`), files it changed but does not own (`ownership.ts`) -- and
 * fails the run. One function for both so the two rejections can never charge, guard or announce
 * differently.
 *
 * The task first: a crash before the run is failed still leaves the reason on the task. The
 * rejection is `rejectTask`'s rework-or-fail, applied only while `run` still holds the task
 * ({@link rejectOwnedTask}), with the same `task.rework`/`task.failed` events verify's and review's
 * rejections write -- so the board and the Supervisor see it like any other rework and, at the cap,
 * the task's own terminal (§13). `exhaustedReason` is the `task.failed` reason given the attempt
 * the task ended on; `failDetail` is the `run.failed` reason.
 *
 * Returns whether the rejection applied. `false`: the task was no longer this run's (final review
 * I3) -- a replay of a conclusion this already rejected, or a late result for a task a person
 * cancelled. Charging it again would spend a second attempt or revive the task, so only the run is
 * failed. The run is failed either way.
 */
export async function rejectRunBack(
  run: { readonly id: string; readonly slaveId: string },
  task: { readonly id: string; readonly workspaceId: string },
  reason: string,
  failDetail: string,
  exhaustedReason: (attempt: number) => string = (attempt) => `${failDetail} (after ${String(attempt)} attempts)`,
): Promise<boolean> {
  const counted = await rejectOwnedTask(task.id, run.id, reason)
  if (counted !== null) {
    await appendEvent(
      counted.exhausted
        ? {
            type: 'task.failed',
            workspaceId: task.workspaceId,
            taskId: task.id,
            actor: 'system',
            payload: { reason: exhaustedReason(counted.attempt) },
          }
        : {
            type: 'task.rework',
            workspaceId: task.workspaceId,
            taskId: task.id,
            actor: 'system',
            payload: { reason, attempt: counted.attempt },
          },
    )
  }
  await failConcludedRun(run, task.workspaceId, failDetail)
  return counted !== null
}

/**
 * `rejectTask`'s rework-or-fail, but only while `run` still holds the task (`activeRunId`), the
 * guard `releaseTaskAfterFailure` puts on every release. Both writes are conditioned on it inside
 * one transaction, so a replay or a cancel that won the race matches nothing and charges nothing.
 * `null` when the task was not this run's to reject.
 */
async function rejectOwnedTask(
  taskId: string,
  runId: string,
  reason: string,
): Promise<{ readonly attempt: number; readonly exhausted: boolean } | null> {
  return prisma.$transaction(async (tx) => {
    const charged = await tx.task.updateMany({
      where: { id: taskId, activeRunId: runId },
      data: { attempt: { increment: 1 } },
    })
    if (charged.count === 0) return null
    const after = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { attempt: true, maxAttempts: true } })
    const exhausted = after.attempt >= after.maxAttempts
    await tx.task.updateMany({
      where: { id: taskId, activeRunId: runId },
      // `lastRejectionReason` is the slave-facing channel: the next run's `rejection` section.
      data: { status: exhausted ? 'failed' : 'rework', activeRunId: null, lastRejectionReason: reason },
    })
    return { attempt: after.attempt, exhausted }
  })
}
