import { prisma } from '@slave-of-ai/db/client'
import { REVIEW_RETRY_CAP, type Result, err, ok } from '@slave-of-ai/domain'
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
  /**
   * Who is unblocking, as the `task.unblocked` ENVELOPE actor (M38 t2, spec erratum E4). `'human'`
   * -- the default, and every caller that predates M38 -- is an operator or a web request;
   * `'system'` is the Supervisor applying a decision of its own. Nothing else about the verb
   * moves with it: the same checks, the same write, the same payload. The envelope enum has no
   * `supervisor` member, and the `SupervisorDecision` row is where that authorship is recorded.
   */
  readonly origin?: 'human' | 'system'
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
 * Since M42 t1 (spec R6b) there is a second destination, and only one. A task parked while it was
 * being REVIEWED goes back to `reviewing`: a review run holds no implementation attempt, and
 * `rework` would spend one re-doing work nobody has judged wrong -- the same argument `sweep.ts`
 * makes for a review run's own release. It goes back to `reviewing` only while a review can still
 * run, though: `dispatchReview`'s `REVIEW_RETRY_CAP` counts review runs since the latest
 * implementation run, so a task whose review budget is spent would be re-parked `blocked` on the
 * next tick, and for that task `rework` -- a fresh implementation run, which is what resets that
 * count -- is the only unblock that moves anything.
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
): Promise<Result<{ readonly status: 'rework' | 'reviewing' }, ControlRefusal>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (task === null) return err({ kind: 'task_not_found', taskId })
  if (task.status !== 'blocked') return err({ kind: 'task_not_blocked', taskId, status: task.status })
  if (task.activeRunId !== null) {
    return err({ kind: 'task_run_active', taskId, runId: task.activeRunId })
  }

  // Which run parked this task, and therefore where it belongs. All four parks null `activeRunId`
  // in the same write that sets `blocked`, so the blocking run is not on the row any more -- the
  // task's most recent run is. A `review` kind means the task was in `reviewing` when it was
  // parked (the review retry cap, or an operator cancelling a review run through `stop.ts`).
  const latestRun = await prisma.slaveRun.findFirst({
    where: { taskId },
    orderBy: { startedAt: 'desc' },
    select: { kind: true, startedAt: true },
  })

  // ... and whether sending it back there would accomplish anything. `dispatchReview` counts review
  // runs since the latest IMPLEMENTATION run and parks the task `blocked` again the moment that
  // count reaches REVIEW_RETRY_CAP -- so unblocking a cap-spent task to `reviewing` is an unblock
  // that undoes itself on the very next tick, which is exactly the invert-in-one-tick failure this
  // function's own doc comment refuses for `ready`. A fresh implementation run is the only thing
  // that resets that count, and `rework` is how one is started.
  const reviewBudgetSpent = async (): Promise<boolean> => {
    const latestImpl = await prisma.slaveRun.findFirst({
      where: { taskId, kind: 'implementation' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (latestImpl === null) return true
    const attempts = await prisma.slaveRun.count({
      where: { taskId, kind: 'review', startedAt: { gt: latestImpl.startedAt } },
    })
    return attempts >= REVIEW_RETRY_CAP
  }

  const status: 'rework' | 'reviewing' =
    latestRun?.kind === 'review' && !(await reviewBudgetSpent()) ? 'reviewing' : 'rework'

  // The ceiling governs IMPLEMENTATION attempts, and the `reviewing` path spends none: the next run
  // this task gets is a review run, bounded by REVIEW_RETRY_CAP rather than by `maxAttempts`.
  // Checking it there would refuse an unblock that could not have burnt the attempt it is refusing
  // to allow.
  const atCeiling = status === 'rework' && task.attempt >= task.maxAttempts
  if (atCeiling && input.allowAnotherAttempt !== true) {
    return err({ kind: 'attempt_ceiling_reached', taskId, attempt: task.attempt, maxAttempts: task.maxAttempts })
  }
  const maxAttempts = atCeiling ? task.attempt + 1 : task.maxAttempts

  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: 'blocked', activeRunId: null },
    data: { status, maxAttempts },
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
    actor: input.origin ?? 'human',
    payload: { attempt: task.attempt, maxAttempts, status },
    userId: principal?.userId ?? null,
  })
  return ok({ status })
}
