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

/**
 * Takes a task nobody has started off the board (M40 §4).
 *
 * The counterpart to {@link failTask}, and the distinction between them is the whole point of
 * having two verbs: failing says "this was attempted and there is no way forward"; cancelling says
 * "this was never attempted and is no longer wanted". A re-plan produces the second (ruling R1: it
 * PROPOSES one, and a human approves it), and so does an operator who changed their mind.
 *
 * Only from `backlog`, `ready` or `blocked`. `assigned` through `merging` are the pipeline's own
 * and it moves them itself; `rework` and `waiting` are attempts already spent, and `failTask` is
 * their exit; `done`, `failed` and `cancelled` are already terminal. Every one of those is refused
 * with `task_not_cancellable` rather than forced, because cancelling work in flight would throw
 * away real work -- exactly what ruling R1 is protecting.
 *
 * `activeRunId` is checked, not cleared, for `failTask`'s reason: a task carrying one is a task
 * something is still holding.
 *
 * DEPENDENTS are deliberately untouched (ruling R3). The `TaskDependency` rows stay, and the
 * scheduler's integration gate (`apps/orchestrator/src/world.ts`, `dep.status = 'done' AND
 * integratedAt IS NOT NULL`) therefore treats a cancelled dependency as unmet: a task that depends
 * on cancelled work stays unschedulable until a human removes the dependency. The work the
 * dependency stood for was never done, and starting the dependent anyway would be the scheduler
 * deciding on its own that a requirement no longer matters.
 *
 * `origin` sets the ENVELOPE actor of `task.cancelled`, as it does for `failTask` (erratum E4):
 * `'human'` for an operator or a web caller, `'system'` when the Supervisor applied a `cancel_task`
 * decision by itself. The decision row is where the Supervisor's own authorship is recorded.
 */
export async function cancelTask(
  taskId: string,
  reason: string,
  origin: 'human' | 'system' = 'human',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true, status: true, activeRunId: true, goalVersion: true },
    })
    if (task === null) return { ok: false as const, error: { kind: 'task_not_found', taskId } as ControlRefusal }
    if (task.activeRunId !== null) {
      return { ok: false as const, error: { kind: 'task_run_active', taskId, runId: task.activeRunId } as ControlRefusal }
    }
    if (task.status !== 'backlog' && task.status !== 'ready' && task.status !== 'blocked') {
      return {
        ok: false as const,
        error: { kind: 'task_not_cancellable', taskId, status: task.status } as ControlRefusal,
      }
    }
    await tx.task.update({ where: { id: taskId }, data: { status: 'cancelled', lastRejectionReason: reason } })
    return { ok: true as const, workspaceId: task.workspaceId, goalVersion: task.goalVersion }
  })
  if (!outcome.ok) return err(outcome.error)

  // `goalVersion` is the task's OWN stamp -- the goal version whose plan produced it, null for a
  // hand-made task -- so the log says which requirement's work was dropped, without a reader
  // having to join the task row that now says `cancelled` and nothing about why it existed.
  await appendEvent({
    type: 'task.cancelled',
    workspaceId: outcome.workspaceId,
    taskId,
    actor: origin,
    payload: { reason, goalVersion: outcome.goalVersion },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}
