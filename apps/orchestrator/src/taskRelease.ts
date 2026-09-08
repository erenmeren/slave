import { prisma } from '@slave-of-ai/db/client'

/**
 * What {@link releaseTaskAfterFailure} did, so the caller can announce it.
 */
export interface TaskRelease {
  /** The task's attempt count AFTER the increment. */
  readonly attempt: number
  /** `true` when that count reached `maxAttempts` and the task was parked `failed`. */
  readonly exhausted: boolean
}

/**
 * Counts one failed attempt against a task and puts it somewhere it can be retried -- or stops it.
 *
 * Shared by `tick.ts`'s `failToStart` and `concludeFailedResume` (M13 Decision 4), `pump.ts`'s
 * `gate_failed` conclusion, and `verify.ts`'s release of a run that concluded `failed` (M35 Task
 * 1). All four are "an attempted run that failed" in one shape or another, and until M13
 * only the first of them counted: a resume that could not spawn released the task straight back to
 * `rework` with no attempt charged, so a run that failed to resume forever was handed out forever,
 * each attempt costing real money and none of them costing an attempt against the cap.
 *
 * Conditional on still owning the task, and incremented rather than assigned: a caller that lost
 * the claim race -- a cancel, a sweep, or another conclusion for the same run replayed a second
 * time -- must not roll back the winner's task row or burn an attempt against a run that already
 * moved on. That guard is also what makes every caller idempotent: replaying the same `runId`
 * after the first release finds `activeRunId` no longer pointing at it and both writes below match
 * zero rows.
 *
 * `lastRejectionReason` is deliberately NOT written here. It is the slave-facing channel --
 * `buildRunContext`'s `rejection` section puts it in front of the next run as the thing to fix
 * first -- so an
 * orchestrator-side failure landing in it both destroys the verify feedback §8 requires and
 * instructs the next slave to go and fix a setup command it cannot see. The reason lives on the
 * `SlaveRun` row and in `run.failed`, which is where an operator looks for it.
 */
export async function releaseTaskAfterFailure(
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  parked: 'rework' | 'blocked',
): Promise<TaskRelease> {
  return prisma.$transaction(async (tx) => {
    // Both writes inside one transaction (M35 final review, Important 2): the increment and the
    // park used to be two separate `updateMany`s, and a crash between them left the task
    // `attempt + 1`, still `running`, with `activeRunId` pointing at a now-terminal `failed` run --
    // unrecoverable, because `sweep.ts` only reconciles NON-terminal runs and `unblockTask` refuses
    // anything that is not already `blocked`. Wrapping both in `$transaction` makes the pair
    // atomic: either the whole release lands, or neither write does and the task is exactly as it
    // was, for the next caller (a retry, `sweep.ts`, an operator) to find and release properly.
    await tx.task.updateMany({
      where: { id: task.id, activeRunId: runId },
      data: { attempt: { increment: 1 } },
    })
    const after = await tx.task.findUniqueOrThrow({ where: { id: task.id } })
    const exhausted = after.attempt >= task.maxAttempts
    // `exhausted` is reported from THIS write's own outcome, not from the read above: the read can
    // be stale by the time this update runs (a concurrent cancel or sweep can win the race for the
    // same `runId` in between), and reporting `exhausted: true` for a release that actually matched
    // zero rows makes `verify.ts` (~line 211) emit a spurious `task.failed` for a task that is
    // alive somewhere else entirely (`rework`, having been released by the winner instead).
    const park = await tx.task.updateMany({
      where: { id: task.id, activeRunId: runId },
      data: { status: exhausted ? 'failed' : parked, activeRunId: null },
    })
    return { attempt: after.attempt, exhausted: exhausted && park.count > 0 }
  })
}
