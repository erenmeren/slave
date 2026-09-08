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
 * `buildPrompt` puts it in front of the next run as the thing to fix first -- so an
 * orchestrator-side failure landing in it both destroys the verify feedback §8 requires and
 * instructs the next slave to go and fix a setup command it cannot see. The reason lives on the
 * `SlaveRun` row and in `run.failed`, which is where an operator looks for it.
 */
export async function releaseTaskAfterFailure(
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  parked: 'rework' | 'blocked',
): Promise<TaskRelease> {
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { attempt: { increment: 1 } },
  })
  const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  const exhausted = after.attempt >= task.maxAttempts
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { status: exhausted ? 'failed' : parked, activeRunId: null },
  })
  return { attempt: after.attempt, exhausted }
}
