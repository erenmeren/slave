import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Declares a parked task dead (M38 §4).
 *
 * The counterpart to `unblockTask`: the two are the only exits from `blocked`, and they are the
 * whole answer to "a human (or the Supervisor) looked at this park and decided". `unblockTask`
 * says "try again"; this one says "stop waiting on it", which is what a task's DEPENDENTS need --
 * a dead end left `blocked` blocks its dependents forever, and `observe`'s `task_failed` rule is
 * built on exactly that (`failed` with dependents is a situation; `blocked` with dependents is a
 * different one).
 *
 * Only from `rework` or `blocked`. Every other status is refused rather than forced:
 * `backlog`/`ready` have never been attempted (cancelling, not failing, is what an operator means
 * there, and `requestStop` owns that); `assigned` through `merging` are the pipeline's own, and it
 * moves them itself the moment the run it is waiting on ends; `done`, `failed` and `cancelled` are
 * already terminal. `waiting` is deliberately excluded too -- it resolves itself when the answer
 * arrives (M36), so failing it by hand would race the answer.
 *
 * `activeRunId` is checked, not cleared -- `unblockTask`'s judgment call, for its reasons: a
 * parked task carrying one means a bug in whatever parked it or a hand-edited row, and the run it
 * points at might still mean something to whoever put it there.
 *
 * `attempt` is untouched: the count of real attempts this task spent stays true, exactly as it
 * does through an unblock.
 *
 * `origin` sets the ENVELOPE actor of the `task.failed` event (spec erratum E4): `'human'` for an
 * operator or a web caller, `'system'` when the Supervisor applied a `mark_task_failed` decision.
 * The envelope enum has no `supervisor` member, and the decision row (plus its `supervisor.applied`
 * event) is where the Supervisor's own authorship is recorded.
 */
export async function failTask(
  taskId: string,
  reason: string,
  origin: 'human' | 'system' = 'human',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  // One locked transaction for the three checks and the write: `SELECT ... FOR UPDATE` (the
  // `lockSlave` idiom, on a task) serialises this against a concurrent `unblockTask` or a second
  // `failTask`, so the status the checks read is the status the update writes over. Every refusal
  // below is reached BEFORE anything is written, so returning it as a value is safe -- a refusal
  // after a write inside `$transaction` would have to throw, or Prisma would commit that write.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true, status: true, activeRunId: true },
    })
    if (task === null) return { ok: false as const, error: { kind: 'task_not_found', taskId } as ControlRefusal }
    if (task.activeRunId !== null) {
      return { ok: false as const, error: { kind: 'task_run_active', taskId, runId: task.activeRunId } as ControlRefusal }
    }
    if (task.status !== 'rework' && task.status !== 'blocked') {
      return { ok: false as const, error: { kind: 'task_not_failable', taskId, status: task.status } as ControlRefusal }
    }
    await tx.task.update({ where: { id: taskId }, data: { status: 'failed', lastRejectionReason: reason } })
    return { ok: true as const, workspaceId: task.workspaceId }
  })
  if (!outcome.ok) return err(outcome.error)

  // The EXISTING event, not a new one: three places in the orchestrator already append
  // `task.failed` for the pipeline's own dead ends (`tick.ts`, `verify.ts`, `review.ts`), and a
  // reader asking "when did this task die" must not have to know which of four writers did it.
  await appendEvent({
    type: 'task.failed',
    workspaceId: outcome.workspaceId,
    taskId,
    actor: origin,
    payload: { reason },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}
