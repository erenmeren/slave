import { prisma } from '@slave-of-ai/db/client'
import { RETRIES_MAX, REVIEW_RETRY_CAP, type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { setSlavePermission } from './permission.js'
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
  /**
   * E R3: send the task back to REVIEW rather than to rework, and stamp the window the next review
   * counts its attempts from (`Task.reviewWindowFrom`).
   *
   * The one case the ordinary destination gets wrong. `dispatchReview` parks a task `blocked` when
   * `REVIEW_RETRY_CAP` review runs have happened since the latest implementation run -- and when
   * those runs FAILED on infrastructure (a diff too large to read, a spawn that never happened, an
   * adapter refusal) not one of them judged the work. The default rule below reads the spent budget
   * and picks `rework`, which spends an implementation attempt re-doing work nobody found fault
   * with. The stamp is what makes `reviewing` stick: Task 5 makes `dispatchReview` count review
   * runs since this moment rather than since the implementation run, so the cap starts again.
   *
   * The diagnosis behind it is the domain's (`readTaskFailure` on `SupervisorTask.latestFailure`),
   * never this verb's: an operator or the Supervisor asks for it, and what arrives here is the
   * decision.
   */
  readonly retryReview?: boolean
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
  //
  // The window is the LATER of the implementation run and `Task.reviewWindowFrom`, spelled exactly
  // as `dispatchReview` spells it (fix round 1): this reading and that one are about the same
  // task and the same cap, and two different windows would have this verb send a task to
  // `reviewing` that the next tick parks, or to `rework` when a review was still owed it.
  const reviewBudgetSpent = async (): Promise<boolean> => {
    const latestImpl = await prisma.slaveRun.findFirst({
      where: { taskId, kind: 'implementation' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (latestImpl === null) return true
    const windowFrom = new Date(Math.max(latestImpl.startedAt.getTime(), task.reviewWindowFrom?.getTime() ?? 0))
    const attempts = await prisma.slaveRun.count({
      where: { taskId, kind: 'review', startedAt: { gt: windowFrom } },
    })
    return attempts >= REVIEW_RETRY_CAP
  }

  // E R3: the caller asking for another REVIEW overrides both readings above. Deliberately not
  // "and only if the budget is not spent": a cap-spent budget is the exact state this input exists
  // for, and `reviewWindowFrom` below is what stops the re-park the budget check is guarding
  // against. The diagnosis that the reviewer never judged anything was made before the call.
  const status: 'rework' | 'reviewing' =
    input.retryReview === true || (latestRun?.kind === 'review' && !(await reviewBudgetSpent()))
      ? 'reviewing'
      : 'rework'

  // The ceiling governs IMPLEMENTATION attempts, and the `reviewing` path spends none: the next run
  // this task gets is a review run, bounded by REVIEW_RETRY_CAP rather than by `maxAttempts`.
  // Checking it there would refuse an unblock that could not have burnt the attempt it is refusing
  // to allow.
  const atCeiling = status === 'rework' && task.attempt >= task.maxAttempts
  if (atCeiling && input.allowAnotherAttempt !== true) {
    return err({ kind: 'attempt_ceiling_reached', taskId, attempt: task.attempt, maxAttempts: task.maxAttempts })
  }
  const maxAttempts = atCeiling ? task.attempt + 1 : task.maxAttempts

  // E R3: the stamp rides on the SAME write that moves the status, so a task can never be
  // `reviewing` on a retry without the window the next review counts from. Only on the retry path:
  // an ordinary unblock to `reviewing` is the M42 case, where the budget was never spent and the
  // count since the implementation run is still the honest one.
  const retryReview = input.retryReview === true && status === 'reviewing'
  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: 'blocked', activeRunId: null },
    data: { status, maxAttempts, ...(retryReview ? { reviewWindowFrom: new Date() } : {}) },
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
    // `attempt` and `maxAttempts` on every one of them, whatever the destination: the event schema
    // requires both (`packages/domain/src/events/schema.ts`) and `appendEvent` THROWS on a payload
    // the domain cannot parse. `reason` is the E R3 addition -- WHY this task left `blocked`, which
    // is the one thing a reader of two identical unblocks a month apart cannot otherwise tell.
    payload: {
      attempt: task.attempt,
      maxAttempts,
      status,
      ...(retryReview ? { reason: 'retry_review' } : {}),
    },
    userId: principal?.userId ?? null,
  })
  return ok({ status })
}

/** What a retry may carry beyond the task itself (E R3). */
export interface RetryTaskInput {
  /**
   * The cause remedy the diagnosis named, applied BEFORE the task moves: a permission this
   * worker was refused on the run that failed, granted so the next run does not meet the same wall.
   *
   * One decision, two verbs, in order -- and the order is the whole of it. A grant that is refused
   * (a worker who has since been released, an operation the vocabulary does not hold) leaves the
   * task exactly as it was, which is a retry that never happened rather than one that will fail
   * again for the reason the grant was for.
   */
  readonly grant?: { readonly slaveId: string; readonly permissionKind: string } | undefined
  /**
   * The steer note for the next run, written onto `Task.lastRejectionReason`.
   *
   * That column is the worker-facing channel: `runContext`'s `rejection` section renders it on the
   * IMPLEMENTATION order, and a `rework` run is an implementation run -- so a retried task's next
   * prompt reads "A previous attempt was rejected. Address this before anything else: <note>".
   * Nothing else in the product writes a note a retried run can read, and a retry that arrives
   * without one is the coin toss this milestone exists to stop.
   *
   * ABSENT IS NOT EMPTY (fix round 1, Important 1). Leaving it out keeps whatever the column
   * already holds -- which for a failed task is the note `failTask`, `verify.ts` or the review
   * wrote about WHY it failed, the one thing the next run most needs to read. A caller with no
   * note of its own (Task 6's CLI and web retries) must not delete the pipeline's.
   */
  readonly reason?: string | undefined
}

/**
 * The note as the WORKER will read it (fix round 1, Important 2).
 *
 * `candidates.ts`' `lost` remedy prefixes its sentence with `steer: ` -- a LABEL, for the panel and
 * the decision row, which say what kind of remedy was chosen. The prompt around the note already
 * supplies the framing ("A previous attempt was rejected. Address this before anything else:"), so
 * the label after it is machinery leaking into an instruction. The domain keeps the prefix, because
 * that is where it means something; control strips it, because this is where the text crosses over
 * into a worker's prompt.
 *
 * Nothing else is touched: the sentence itself is system-authored (a constant with the run's own
 * recorded reason interpolated), and rewriting a word of it here would make the decision row claim
 * one thing and the worker receive another.
 */
const workerNote = (reason: string): string => reason.replace(/^steer:\s*/u, '')

/**
 * E R3: the exit from `failed` -- the one status this product had no verb for.
 *
 * `failed` is terminal everywhere else (`docs/domain-model.md`): `unblockTask` above refuses it,
 * the scheduler never starts it, and until this milestone the only way out was an operator editing
 * the row. That was the maratus project's 2026-09-20 dead end -- a research task whose three runs
 * were refused the network ended `failed`, and nothing in the product could put it back.
 *
 * What it does, and what it deliberately does not:
 * - `rework`, NEVER `ready`, for {@link unblockTask}'s own reason: the run that failed left this
 *   task's worktree and branch on disk, and `rework` is what tells `tick.ts`'s `acquireWorktree` to
 *   ADOPT them instead of refusing them as someone else's wreckage.
 * - `attempt: 0`. A retry is a fresh set of attempts, which is what makes it different from
 *   `unblockTask`'s `rework` (that one preserves the count, because the work was parked rather than
 *   spent). The ledger of "how many times has a remedy been tried" moves to `Task.retries`, which
 *   this increments and nothing resets.
 * - `activeRunId: null`, because a failed task's run is over and a stale claim would stop the next
 *   dispatch.
 * - `maxAttempts` untouched: the ceiling is the project's setting, not something a retry may raise.
 *   `unblockTask`'s `allowAnotherAttempt` is the verb for that, and it is a different decision.
 *
 * At most {@link RETRIES_MAX} times. The third time, the finding is that the remedies are not
 * working, and `candidates.ts` offers `escalate_to_human` alone -- so this refusal is the belt to
 * that rule's braces, for the decision recorded before the counter reached the ceiling and approved
 * after.
 *
 * `origin` is the `task.unblocked` envelope actor, exactly as {@link UnblockTaskInput.origin}
 * describes it. The EXISTING event, not a new one: a task leaving a park is `task.unblocked`
 * whichever park it left, and the payload's `reason` says which -- a reader asking "when did this
 * task start moving again" must not have to know there are two verbs.
 *
 * THE GRANT AND THE MOVE ARE NOT ONE TRANSACTION, and the direction that leaves is the deliberate
 * one (fix round 1, minor): `setSlavePermission` commits on its own before the task is claimed, so
 * a transaction that then ROLLS BACK -- a lost race with a concurrent `failTask`, a database error
 * -- leaves a worker holding a permission a person can see (it wrote a `slave.permission_changed`
 * with the approver on it) and a task that did not move. The reverse pairing would be worse in kind
 * rather than in degree: a task retried into the very wall the grant was for, failing again for a
 * reason the decision had already answered, which is the loop this milestone exists to break. A
 * stray allow is visible, revocable by `clearSlavePermission`, and grants nothing that was not just
 * decided; a retry without its remedy is a run's worth of spend and a second identical failure.
 */
export async function retryTask(
  taskId: string,
  input: RetryTaskInput = {},
  principal?: Principal,
  opts: { readonly origin?: 'human' | 'system' } = {},
): Promise<Result<{ readonly status: 'rework'; readonly retries: number }, ControlRefusal>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (task === null) return err({ kind: 'task_not_found', taskId })
  if (task.status !== 'failed') return err({ kind: 'task_not_failed', taskId, status: task.status })
  if (task.retries >= RETRIES_MAX) {
    return err({ kind: 'retry_ceiling_reached', taskId, retries: task.retries, limit: RETRIES_MAX })
  }

  // FIRST, and outside the transaction below, so a refusal here is a retry that never happened.
  // `setSlavePermission` re-validates the kind against `PERMISSION_KINDS` and re-reads the worker,
  // so a decision that waited a day and names a worker who has since been released is refused
  // rather than written. THE APPROVER IS THE GRANTER, as in `carryOut`'s `request_permission` arm:
  // `principal` lands on the row and in the event, and the Supervisor only ever asked.
  if (input.grant !== undefined) {
    const granted = await setSlavePermission(input.grant.slaveId, input.grant.permissionKind, 'allow', principal)
    if (!granted.ok) return granted
  }

  // One locked transaction for the re-check and the write (`failTask`'s idiom): `SELECT ... FOR
  // UPDATE` serialises this against a concurrent retry or a `failTask`, so the status the check
  // reads is the status the update writes over. Every refusal inside is reached BEFORE anything is
  // written -- a refusal after a write would have to throw, or Prisma commits that write.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`
    const current = await tx.task.findUnique({
      where: { id: taskId },
      select: { status: true, retries: true, maxAttempts: true },
    })
    if (current === null) return { ok: false as const, error: { kind: 'task_not_found', taskId } as ControlRefusal }
    if (current.status !== 'failed') {
      return { ok: false as const, error: { kind: 'task_not_failed', taskId, status: current.status } as ControlRefusal }
    }
    if (current.retries >= RETRIES_MAX) {
      return {
        ok: false as const,
        error: { kind: 'retry_ceiling_reached', taskId, retries: current.retries, limit: RETRIES_MAX } as ControlRefusal,
      }
    }
    await tx.task.update({
      where: { id: taskId },
      data: {
        status: 'rework',
        attempt: 0,
        activeRunId: null,
        // `increment`, not the number this call read: the counter is the row's, and two retries
        // that somehow raced must not both write "1".
        retries: { increment: 1 },
        // Only when the caller brought one (fix round 1, Important 1): `null` here would erase the
        // failure note the pipeline wrote, which is the note the rework run reads. Stripped of the
        // `steer: ` label the domain puts on it for its own surfaces (Important 2).
        ...(input.reason === undefined ? {} : { lastRejectionReason: workerNote(input.reason) }),
      },
    })
    return { ok: true as const, retries: current.retries + 1, maxAttempts: current.maxAttempts }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'task.unblocked',
    workspaceId: task.workspaceId,
    taskId,
    actor: opts.origin ?? 'human',
    // `attempt`/`maxAttempts` because the event schema requires them (see {@link unblockTask}); the
    // rest is what this milestone added -- which park was left, how many remedies have been spent,
    // and the grant that rode along, so a reader of the row months later can see the whole decision
    // without the `SupervisorDecision` beside it.
    payload: {
      attempt: 0,
      maxAttempts: outcome.maxAttempts,
      status: 'rework',
      retries: outcome.retries,
      reason: 'retry_task',
      ...(input.grant === undefined ? {} : { grant: input.grant }),
    },
    userId: principal?.userId ?? null,
  })
  return ok({ status: 'rework', retries: outcome.retries })
}
