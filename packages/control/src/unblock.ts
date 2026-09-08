import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

export interface UnblockTaskInput {
  /**
   * Explicit permission to raise `maxAttempts` when the task is already at (or, after a lowered
   * workspace setting, past) its ceiling -- see the doc comment below. Consulted ONLY when the
   * ceiling actually applies: passing it on a task comfortably under its cap changes nothing.
   */
  readonly allowAnotherAttempt?: boolean
}

/**
 * M35 t5: the exit from `blocked` that Task 4's review found missing. Four places park a task
 * there -- `tick.ts`'s `failToStart` on a worktree conflict (charges an attempt),
 * `verify.ts`'s `advance` on a verify misconfiguration (charges nothing), `review.ts`'s
 * `dispatchReview` when the review retry cap is spent (charges nothing), and this package's own
 * `stop.ts` on an operator cancel (charges nothing) -- and until now nothing moved a task out.
 * `decide()`'s `STARTABLE` is `['ready', 'rework']`, so `blocked` needed a real exit, not a
 * second silent status.
 *
 * Moves the task to `rework`, never `ready`. Every one of the four parks reaches `blocked` only
 * after the task's OWN branch (`Task.branch`) has already been claimed by a prior attempt --
 * `tick.ts`'s claim writes it before provisioning is even attempted, so it is set by the time
 * `failToStart` runs, and the other three parks all happen well after that same claim. `rework`
 * is what tells `tick.ts`'s `acquireWorktree` to ADOPT a leftover worktree/branch instead of
 * refusing it as someone else's wreckage (`isRework: task.status === 'rework'`) -- exactly the
 * state an unblocked task is in. `ready` would tell the very next `provisionWorktree` call to
 * insist on a clean slate, which is not what any of the four parks left behind: a task unblocked
 * to `ready` that still has its old worktree/branch on disk would throw `WorktreeExistsError`
 * again on the next tick and land right back in `blocked` via `tick.ts` -- an unblock that undoes
 * itself. `rework` costs nothing when the leftover state turns out not to exist either --
 * `acquireWorktree` only adopts when `provisionWorktree` actually throws, so a task with a
 * genuinely clean worktree is provisioned fresh either way.
 *
 * This reads as the opposite of `tick.ts`'s `failToStart`, which picks `blocked` SPECIFICALLY so
 * the task is NOT `rework` -- its own comment says landing in `rework` "would hold for one tick
 * and then invert itself", because `rework` is the exact precondition `acquireWorktree` tests for
 * before it ADOPTS a leftover worktree/branch it just refused as someone else's wreckage. Sending
 * the task to `rework` here reaches for precisely the adoption `failToStart` was written to defer.
 * The two are not actually in tension: `failToStart` is deferring adoption absent a human in the
 * loop, and an explicit call to this function IS that human -- an operator who looked at the
 * `blocked` task, decided the leftover worktree/branch is exactly what the next attempt should
 * pick up rather than fight, and said so. `rework` is what tells `acquireWorktree` to adopt; a
 * human unblock is the sanction that makes that adoption the right call instead of the silent
 * invert-in-one-tick `failToStart`'s comment warns against.
 *
 * That sanction is only as good as the operator's own look, though: a leftover that is only
 * PARTIALLY there (`WorktreeExistsError.reason === 'directory'` or `'branch'`, not `'both'`) is not
 * something `acquireWorktree` will adopt even from `rework` -- it adopts only the `'both'` case,
 * so a partial leftover throws again on the very next tick, and that throw re-parks the task
 * `blocked` (via `taskRelease.ts`'s park, since `failToStart` treats any `WorktreeExistsError` the
 * same way) and burns another attempt doing it. An operator unblocking a task parked for a partial
 * leftover should clear the stray directory/branch by hand first -- unblocking onto it merely
 * repeats the failure at the cost of the attempt this verb was meant to spend on real progress.
 *
 * `activeRunId` is checked, not cleared: all four parks already null it in the SAME write that
 * sets `blocked` (`taskRelease.ts`, `verify.ts`'s `advance`, `review.ts`'s cap park, and
 * `stop.ts`), so a blocked task carrying one is not a state any of them can produce. Refusing
 * (`task_run_active`) rather than silently clearing it is the judgment call: a nonzero value here
 * means either a bug in one of the four parks or a hand-edited row, and either way the run it
 * still points at might mean something to whoever put it there -- guessing it is safe to drop is
 * a worse failure mode than making an operator look at it once.
 *
 * `attempt` is never reset -- the whole count of real attempts this task has already spent stays
 * true. That is also why the ceiling is checked here at all: `decide()` has no idea what
 * `Task.attempt` is, so an unblock to `rework` on a task already at (or past) `maxAttempts` would
 * be scheduled exactly like any other, spend a real run, and -- for the charging park
 * (`tick.ts`) -- land right back in `failed` the moment that run's own release runs the same
 * `attempt >= maxAttempts` check `taskRelease.ts` already has. Refusing up front says so before
 * the run is spent rather than after. `allowAnotherAttempt` is this verb's own escape hatch, not
 * a separate control verb to raise `maxAttempts` (none exists elsewhere in this package): it
 * raises the ceiling to exactly `attempt + 1` -- one more attempt, no more -- in the same write
 * that unblocks, so the ledger still reads as "N real attempts, N+1 allowed" rather than a reset.
 */
export async function unblockTask(
  taskId: string,
  input: UnblockTaskInput = {},
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (task === null) return err({ kind: 'task_not_found', taskId })
  if (task.status !== 'blocked') return err({ kind: 'task_not_blocked', taskId, status: task.status })
  if (task.activeRunId !== null) {
    return err({ kind: 'task_run_active', taskId, runId: task.activeRunId })
  }

  const atCeiling = task.attempt >= task.maxAttempts
  if (atCeiling && input.allowAnotherAttempt !== true) {
    return err({ kind: 'attempt_ceiling_reached', taskId, attempt: task.attempt, maxAttempts: task.maxAttempts })
  }
  const maxAttempts = atCeiling ? task.attempt + 1 : task.maxAttempts

  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: 'blocked', activeRunId: null },
    data: { status: 'rework', maxAttempts },
  })
  if (claimed.count === 0) {
    // Lost a race -- another call (or, in principle, some other writer) moved this task between
    // the reads above and this write. Re-read rather than guess: the two preconditions above are
    // independent, so which one now fails is worth reporting accurately.
    const now = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    if (now.activeRunId !== null) return err({ kind: 'task_run_active', taskId, runId: now.activeRunId })
    return err({ kind: 'task_not_blocked', taskId, status: now.status })
  }

  await appendEvent({
    type: 'task.unblocked',
    workspaceId: task.workspaceId,
    taskId,
    actor: 'human',
    payload: { attempt: task.attempt, maxAttempts },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}
