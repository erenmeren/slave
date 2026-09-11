import {
  constrainRun,
  deliverBreakerSteer,
  isAlive,
  realWorktreeProbe,
  type WorktreeProbe,
} from '@slave-of-ai/control'
import { prisma as db } from '@slave-of-ai/db/client'
import {
  BREAKER_BEAT_MS,
  BREAKER_WINDOW,
  CONSTRAIN_GRACE_CALLS,
  type BreakerRow,
  type BreakerVerdict,
  detectBehaviour,
  runId as brandRunId,
  steerTextFor,
  type RunId,
  type RunStatus,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { resolveAdapter } from './provider.js'

export interface SweepDeps {
  readonly workspaceId: WorkspaceId
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. */
  readonly registry: AdapterRegistry
  /**
   * Run ids whose pumps are live in THIS process (`tick.ts`'s `activePumpRunIds`). The dead-pid
   * arm skips these: a dead pid under a live pump is the ordinary end of a run with its terminal
   * write still in flight, not an orphan -- concluding it here races the pump (the M9 gate
   * failure). Optional so direct callers (tests, a future one-shot) can sweep unfiltered.
   */
  readonly livePumpRunIds?: ReadonlySet<string>
  /**
   * How the breaker's worktree clock is measured (M51 R1, plan erratum E7). Optional and defaulting
   * to {@link realWorktreeProbe}, so every existing direct caller and test compiles unchanged --
   * the `livePumpRunIds` precedent directly above.
   *
   * A SECOND interface rather than a third method on `GitProbe`: see `WorktreeProbe`'s own
   * docstring in `packages/control/src/git-probe.ts` for why that one may not grow one.
   */
  readonly worktreeProbe?: WorktreeProbe
}

export interface SweepReport {
  readonly timedOut: readonly RunId[]
  readonly overToolCap: readonly RunId[]
  readonly deadPids: readonly RunId[]
  /** Task ids whose `activeRunId` pointed at a run that was already over (M42 t1, spec R6a). */
  readonly strandedClaims: readonly string[]
  /** M51 R2: the runs this sweep moved UP a rung, one list per rung. Empty on every tick of a
   *  healthy project, which is nearly all of them. A run appears in exactly one of the three per
   *  beat -- one rung, one name. */
  readonly breakerSteered: readonly RunId[]
  readonly breakerConstrained: readonly RunId[]
  readonly breakerStopped: readonly RunId[]
}

/**
 * The statuses an orphan pass may act on: every non-terminal status **except `paused`**.
 *
 * `paused` is excluded *before* liveness is ever consulted. Spec §3.4 says the pass fails every
 * non-terminal run with a dead pid, and `paused` is non-terminal — but a paused run has no process
 * by design: the adapter killed it, which is what pausing *is* (Task 8). So it presents in exactly
 * the orphan shape, and a pass that discriminates on liveness alone destroys every paused run in
 * the fleet on the first daemon restart, along with the checkpoint written to preserve it.
 * Excluding it completes §3.4 against Task 8's behaviour rather than contradicting it: the rule's
 * subject is a process that died *unexpectedly*, and a paused run's did not.
 */
const ORPHANABLE: readonly RunStatus[] = NON_TERMINAL_RUN_STATUSES.filter((status: RunStatus) => status !== 'paused')

/**
 * The statuses the per-tick sweep may act on. `stopping` is excluded here but not above: a run
 * already being cancelled must not be cancelled again on the next tick, or a run that takes a
 * moment to die is re-announced once per second, forever, into an append-only log — the hazard
 * §3.2 spends three paragraphs on for the halt command. The orphan pass still fails it if its
 * process is gone, which is how a run that never finished dying is eventually concluded.
 */
const SWEEPABLE: readonly RunStatus[] = ORPHANABLE.filter((status: RunStatus) => status !== 'stopping')

/** The mirror of {@link NON_TERMINAL_RUN_STATUSES}: a run in one of these will never be concluded
 *  again, so a task still pointing at one is pointing at nothing. */
const TERMINAL: readonly RunStatus[] = ['stopped', 'succeeded', 'failed']

/**
 * The FLOOR of the stranded-claim grace: the gap between a terminal write and the database work
 * that follows it, in a process this one cannot see (M42 t1).
 *
 * `livePumpRunIds` closes that window inside THIS process exactly -- `activePumpRunIds.delete` runs
 * in the pump chain's `.finally()`, after `verifyConcludedRun`, so a run in the set still owns its
 * task. It says nothing about another process, and there is always another process to worry about:
 * the CLI's one-shot `tick` and `resume-run` run the very same conclusion chain beside a live
 * daemon (`startRun`'s own reasoning for claiming in the database rather than in memory). Thirty
 * seconds is far past any run of database writes and far short of anything an operator would
 * notice.
 *
 * It is a floor and not the whole grace because a conclusion is not only database writes. See
 * {@link strandedClaimGraceMs}.
 */
export const STRANDED_CLAIM_GRACE_MS = 30_000

/** The workspace fields {@link strandedClaimGraceMs} needs -- the row `sweep` already loads. */
export interface StrandedClaimGraceWorkspace {
  readonly runTimeoutMs: number
  readonly verifyCommands: readonly string[]
}

/**
 * How long a run of this kind must have been terminal before its task's claim is stranded rather
 * than merely mid-release (spec erratum E22).
 *
 * PER KIND, because the two conclusions are not the same length of work. A `review` run's
 * conclusion is database-only -- `concludeReviewRun` parses the verdict text and moves the task --
 * so the floor covers it with three orders of magnitude to spare. An `implementation` run's does
 * not stop at the terminal write: `pumpRun` writes `succeeded` and only THEN chains
 * `verifyConcludedRun`, which runs every one of the workspace's verify commands -- each of them
 * allowed to take `runTimeoutMs` -- before `advance()` releases the claim. Under the flat floor
 * this arm would reach a task whose CLI `tick` is three minutes into `npm test`, hand it back to
 * `rework`, and the next tick's slave would adopt the worktree that verify is still running in:
 * two slaves, one branch, which is the exact failure `Task.activeRunId` exists to prevent.
 *
 * `max(1, verifyCommands.length)` because a workspace with no verify commands still has a
 * conclusion to run, and zero would collapse the whole allowance to the floor.
 *
 * What this does NOT cover, deliberately: a verify that legitimately outlives the workspace's own
 * ceiling. Nothing can -- `runTimeoutMs` is what the workspace says the longest command may take,
 * so waiting longer than the sum of them would mean disbelieving the workspace's own setting. The
 * cost of the choice is on the other side: a process that really did die mid-verify leaves its
 * task busy for the length of the longest verify the workspace allows, and self-heals only after
 * that. Slow, and correct; the opposite trade loses work.
 */
export function strandedClaimGraceMs(
  // `'planning'` narrowed out (parked cleanup): a planning run holds no task's claim at all (M8b,
  // `verify.ts`'s `advance`), so it can never reach the one call site below -- the parameter said
  // otherwise only because `SlaveRun.kind` has a third member.
  kind: 'implementation' | 'review',
  workspace: StrandedClaimGraceWorkspace,
): number {
  if (kind === 'review') return STRANDED_CLAIM_GRACE_MS
  return STRANDED_CLAIM_GRACE_MS + workspace.runTimeoutMs * Math.max(1, workspace.verifyCommands.length)
}

/**
 * Whether a tick has run in this process.
 *
 * `reconcileOrphans` treats a non-terminal run with no pid as an orphan, because nothing will ever
 * conclude it -- but that same shape exists legitimately for a few milliseconds inside every
 * `startRun`, between creating the row and recording the pid. Reconciling while a tick is in
 * flight therefore fails a run seconds from spawning, releases its task to `rework`, and the next
 * tick adopts the live run's worktree with a second slave: two slaves, one branch, which is the
 * thing Task 13's atomic claim exists to prevent.
 *
 * Documented, that constraint was silent when broken. This makes it loud.
 */
let ticksHaveRun = false

/** Called by `tick` on entry. Not for callers other than the tick itself. */
export function noteTickRan(): void {
  ticksHaveRun = true
}

/** For tests, which run many independent daemon lifetimes inside one process. */
export function resetTickObservation(): void {
  ticksHaveRun = false
}

/**
 * Fails every non-terminal run this workspace left behind in a previous process (spec §3.4).
 *
 * **Startup only, and that is load-bearing rather than incidental.** A non-terminal run with a
 * `null` pid is an orphan here, because nothing will ever conclude it — but that same shape exists
 * legitimately for a few milliseconds inside every `startRun`, between creating the `SlaveRun` row
 * and recording the pid the adapter returns. Running this concurrently with a tick would fail runs
 * that are moments from spawning. §3.4 places it before the first tick; a caller that puts it on a
 * timer instead has to close that window some other way.
 *
 * The worktree is preserved (§7.4): it is the inspection surface, and an orphan is the case where
 * an operator most needs to see how far the run got.
 */
export async function reconcileOrphans(deps: SweepDeps): Promise<number> {
  if (ticksHaveRun) {
    throw new Error(
      'reconcileOrphans is startup-only: a tick has already run in this process, so a run that is ' +
        'mid-spawn is indistinguishable from one this pass should fail',
    )
  }


  // `slave: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and this pass exists precisely to fail an orphan whichever kind it is.
  const runs = await db.slaveRun.findMany({
    where: { status: { in: [...ORPHANABLE] }, slave: { team: { workspaceId: deps.workspaceId } } },
  })

  let failed = 0
  for (const run of runs) {
    // Pid-liveness semantics (EPERM=alive, null/<=0=dead) live with the shared implementation in
    // packages/providers/src/runtime/process.ts.
    if (isAlive(run.pid)) continue

    const now = new Date()
    await db.slaveRun.update({
      where: { id: run.id },
      // `terminalAt` matters: it is the key `loadWorld` orders the failure streak by, and an orphan
      // concluded without it sorts by `startedAt` instead — the mixed-clock case Task 10 carried.
      data: { status: 'failed', terminalAt: now, endedAt: now },
    })

    // Release the task the run was holding. `startRun` (tick.ts) and `dispatchReview` (review.ts,
    // M41 Task 3b) both claim the task with `activeRunId` when they start one; failing the run and
    // leaving the task pointing at it strands the task busy forever, and nothing else in the
    // milestone reconciles *tasks*.
    //
    // What "released" means depends on the kind, and only since a review run holds a claim at all:
    // an `implementation` run's task goes back to `rework` to be picked up again, but a `review`
    // run's task gets ONLY its claim back and stays exactly where it is, in `reviewing`. A daemon
    // that died is not the reviewer rejecting the work, and `rework` would spend an implementation
    // attempt re-doing work nobody has judged wrong -- `dispatchReview`'s own retry cap is what
    // bounds review, and a `reviewing` task with a null claim is precisely what it re-dispatches.
    //
    // No attempt is counted either way. A daemon that died is not the slave failing, and counting it
    // would let a crash-looping daemon exhaust every task's attempts and fail the lot — losing real
    // work to an infrastructure problem. Same reasoning as Task 14's non-slave verify outcomes.
    //
    // A `planning` run (M8b) has no task to release -- `taskId` is `null` and there is nothing
    // else in this block for it.
    const task = run.taskId === null ? null : await db.task.findUniqueOrThrow({ where: { id: run.taskId } })
    const released =
      run.taskId === null
        ? { count: 0 }
        : await db.task.updateMany({
            where: { id: run.taskId, activeRunId: run.id },
            data: run.kind === 'review' ? { activeRunId: null } : { status: 'rework', activeRunId: null },
          })

    await appendEvent({
      type: 'run.failed',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: {
        reason:
          run.pid === null
            ? 'the run was never recorded as started, and no process is tracking it: it was orphaned by a restart'
            : `the run's process (pid ${run.pid}) is gone but the run never concluded: it was orphaned by a restart`,
      },
    })
    if (released.count > 0 && task !== null && run.kind !== 'review') {
      // §13: no failure is silent. `failToStart` and `advance` both announce a task they park in
      // `rework`; a reader would otherwise see a run fail with no record of the task going back
      // into the queue. Only when this pass is what released it -- and only for a kind this pass
      // actually parked in `rework`: a released `review` claim leaves the task in `reviewing`, and
      // announcing `task.rework` for it would be a lie about where the task went.
      await appendEvent({
        type: 'task.rework',
        workspaceId: deps.workspaceId,
        taskId: task.id,
        actor: 'system',
        // `attempt + 1` is the number of the attempt that was interrupted: the counter records
        // *completed* attempts and this pass deliberately does not increment it, but the run that
        // died had started. The schema requires a positive number, which is also the honest one.
        payload: {
          reason: 'the run working this task was orphaned by a restart',
          attempt: task.attempt + 1,
        },
      })
    }
    failed += 1
  }

  // Crash recovery for the merge pass (spec §4): a claimed merge whose process died mid-way is the
  // same shape a run orphan is -- a claim nothing will ever release -- so it gets the same M5
  // resume-claim treatment applied to tasks instead of runs. No attempt is counted, for the same
  // reason a dead daemon does not count against a run's orphan: a crashed process is not the slave
  // failing.
  const interrupted = await db.task.findMany({
    where: { workspaceId: deps.workspaceId, status: 'merging', mergeClaimedAt: { not: null } },
  })
  for (const task of interrupted) {
    await db.task.update({
      where: { id: task.id },
      data: { status: 'rework', mergeClaimedAt: null, lastRejectionReason: 'merge interrupted' },
    })
    await appendEvent({
      type: 'task.merge_failed',
      workspaceId: deps.workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { reason: 'merge interrupted' },
    })
  }

  return failed
}

/**
 * Releases a task whose `activeRunId` names a run that is ALREADY terminal (spec R6a).
 *
 * The gap this closes is not the one `reconcileOrphans` and `concludeDeadRun` close. Both of those
 * release the task in the same pass that concludes the run; neither can reach a task whose run was
 * concluded by somebody else and whose release never happened -- a process killed between
 * `pumpRun`'s terminal write and its chained `verifyConcludedRun`, or a `verifyConcludedRun` that
 * threw. A task like that is busy forever: `decide()` never schedules it, `dispatchReview` will not
 * claim it, and `unblockTask`/`cancelTask`/`failTask` all refuse it with `task_run_active`.
 *
 * What "released" means is the kind's, exactly as the other two arms have it: an `implementation`
 * run's task goes back to `rework` and a `review` run's task gets only its claim back and stays in
 * `reviewing` -- a review nobody concluded is not the reviewer rejecting the work, and `rework`
 * would spend an implementation attempt re-doing work nobody judged wrong. No attempt is counted
 * either way.
 *
 * Three guards, and each one is load-bearing:
 *   1. `livePumpRunIds` -- a conclusion in flight in THIS process still owns its task.
 *   2. {@link strandedClaimGraceMs} -- a conclusion in flight in ANOTHER process does too, and this
 *      process cannot see its pump set. Per kind: an implementation conclusion has the workspace's
 *      whole verify window still ahead of it after the terminal write, a review conclusion does not.
 *   3. the `status` in the `updateMany` `where` -- a task that has legitimately moved on since the
 *      read (a cancel, an operator's park) loses only the stale claim, never its status.
 *
 * No `guardrail.tripped` (spec R6a): nothing was cancelled and no ceiling was crossed. A `task.rework`
 * is announced for the implementation kind alone, mirroring `reconcileOrphans`, because §13 says no
 * failure is silent -- and announcing one for a review would be a lie about where the task went.
 */
export async function reconcileStrandedClaims(
  deps: SweepDeps,
  /** The workspace row `sweep` already loaded; re-read when a direct caller has none of its own. */
  workspace?: StrandedClaimGraceWorkspace,
): Promise<readonly string[]> {
  const claimed = await db.task.findMany({
    where: { workspaceId: deps.workspaceId, activeRunId: { not: null } },
    select: { id: true, status: true, activeRunId: true, attempt: true },
  })
  if (claimed.length === 0) return []

  const grace =
    workspace ??
    (await db.workspace.findUniqueOrThrow({
      where: { id: deps.workspaceId },
      select: { runTimeoutMs: true, verifyCommands: true },
    }))

  const now = Date.now()
  // `activeRunId as string` throughout: `{ not: null }` in the `where` above is what makes every
  // one of these non-null, and Prisma's generated row type cannot express that narrowing.
  const runs = await db.slaveRun.findMany({
    where: {
      id: { in: claimed.map((task) => task.activeRunId as string) },
      status: { in: [...TERMINAL] },
      // The FLOOR only, as a cheap prefilter -- a run inside even the shortest per-kind grace is
      // inside every one of them. `strandedClaimGraceMs` below is what actually decides.
      terminalAt: { lt: new Date(now - STRANDED_CLAIM_GRACE_MS) },
    },
    select: { id: true, taskId: true, kind: true, status: true, terminalAt: true },
  })
  const strandedBy = new Map(runs.map((run) => [run.id, run] as const))

  const released: string[] = []
  for (const task of claimed) {
    const run = strandedBy.get(task.activeRunId as string)
    if (run === undefined) continue
    // The claim is a bare `@unique` column, not a foreign key: nothing at the database level makes
    // a task's `activeRunId` name a run that agrees the task is its own. It always does in practice
    // -- `startRun` and `dispatchReview` write the pointer in the same breath as the run row -- but
    // the release below is per KIND, so a pointer that disagreed would apply one run's rules to
    // another run's task. Cheaper to check than to reason about.
    if (run.taskId !== task.id) continue
    if (deps.livePumpRunIds?.has(run.id) === true) continue
    if (run.terminalAt === null) continue
    // A `planning` run never holds a task's claim (M8b) -- reaching one here would be bad data,
    // not a claim to reconcile, and this is also what narrows `run.kind` for `strandedClaimGraceMs`.
    if (run.kind === 'planning') continue
    if (now - run.terminalAt.getTime() < strandedClaimGraceMs(run.kind, grace)) continue

    const toRework = run.kind !== 'review' && task.status === 'running'
    const write = await db.task.updateMany({
      where: { id: task.id, activeRunId: run.id, ...(toRework ? { status: 'running' as const } : {}) },
      data: toRework ? { status: 'rework', activeRunId: null } : { activeRunId: null },
    })
    if (write.count === 0) continue
    // No log line of its own: `strandedClaims` in the returned {@link SweepReport} is this arm's
    // channel, exactly as `timedOut`/`overToolCap`/`deadPids` are the others', and the daemon
    // prints the whole report when any of them is non-empty.
    released.push(task.id)
    if (!toRework) continue
    await appendEvent({
      type: 'task.rework',
      workspaceId: deps.workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: {
        reason: 'the run holding this task was already over and never released it',
        // The number of the attempt that was interrupted: the counter records COMPLETED attempts
        // and this pass deliberately does not increment it, but the run that stranded it had started.
        attempt: task.attempt + 1,
      },
    })
  }
  return released
}

/**
 * One pass over this workspace's live runs, per tick (spec §3.3).
 *
 * Reports a dead pid but does not act on it: concluding an orphan is `reconcileOrphans`' job, and
 * keeping the two apart means the startup pass and the per-tick pass cannot come to disagree about
 * what a dead pid means.
 */
export async function sweep(deps: SweepDeps): Promise<SweepReport> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId } })
  // `slave: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and the timeout/tool-cap guardrails below must still reach it.
  const runs = await db.slaveRun.findMany({
    where: { status: { in: [...SWEEPABLE] }, slave: { team: { workspaceId: deps.workspaceId } } },
  })

  const timedOut: RunId[] = []
  const overToolCap: RunId[] = []
  const deadPids: RunId[] = []
  const breakerMoves: Record<BreakerMove, RunId[]> = {
    breakerSteered: [],
    breakerConstrained: [],
    breakerStopped: [],
  }

  // BEFORE the per-run loop, and on every tick rather than on the beat (M51 R3, erratum E8). The
  // loop cannot do this: `paused` is not in `SWEEPABLE`, so a parked run is not even in `runs`
  // above, and the loop skips a run with no pid -- which a paused run never has, because pausing IS
  // killing the child. And a steer that has been queued should land as soon as the run is actually
  // parked, not up to a minute later.
  await deliverBreakerSteers(deps)

  for (const run of runs) {
    // The pid, not liveness, is what tells a dead run from one that is mid-spawn: Task 13 records
    // the pid only after the adapter has returned a live handle, so a null pid here is a run about
    // to start and no other case. Discriminating on it is what makes §3.3's dead-pid rule
    // implementable from inside a running daemon rather than only at startup.
    if (run.pid === null) continue

    if (!isAlive(run.pid)) {
      // A live pump owns this run's conclusion; the dead pid just means the child finished.
      if (deps.livePumpRunIds?.has(run.id) === true) continue
      deadPids.push(brandRunId(run.id))
      await concludeDeadRun(deps, run)
      continue
    }

    const timedOutNow = Date.now() - run.startedAt.getTime() > workspace.runTimeoutMs
    // M51 R3: the run's OWN cap when the breaker wrote one, the workspace's otherwise -- one
    // comparison and one new column, and the breach it produces is the EXISTING `tool_call_ceiling`.
    // A constrained run really is past its tool-call ceiling; giving the same fact a second name is
    // how a filter comes to miss half of it.
    const overCapNow = run.toolCalls > (run.toolCallCap ?? workspace.maxToolCallsPerRun)
    // M51 R2/E6. The breaker is evaluated here, INSIDE the branch that used to `continue`, which is
    // also exactly what "after the hard limits" means: a run past its timeout or its ceiling is
    // stopped for THAT reason and never reaches the breaker, so one run is never stopped twice
    // under two names. Everything below this line is the hard-limit path, untouched.
    if (!timedOutNow && !overCapNow) {
      // The one `try` in this loop, and it is the breaker's whole "nothing here may throw" promise
      // made good at the boundary rather than asserted inside: this pass spawns git, reads the
      // event log and calls two control verbs, and one of them (`requestPause`, through
      // `constrainRun`) throws outright when the workspace's repo path cannot be stat'd. An escape
      // here would abandon the rest of the sweep -- every LATER run's timeout, ceiling and orphan
      // check -- over one run's unreadable worktree. `pauseActiveRuns`' per-run `try` exists for
      // exactly this, and says so at greater length.
      try {
        const beat = await beatBreaker(deps, run)
        if (beat !== null) breakerMoves[beat].push(brandRunId(run.id))
      } catch (error) {
        console.error(`[sweep] the breaker beat failed for run ${run.id}:`, error)
      }
      continue
    }

    const breaches: string[] = []
    if (timedOutNow) breaches.push(`it has been running longer than the workspace's ${workspace.runTimeoutMs}ms limit`)
    if (overCapNow) {
      // The SAME expression the comparison used (fix round 1, Minor 7). A constrained run has a
      // ceiling of its own, and a sentence naming the workspace's instead told an operator the run
      // was 160 calls short of a limit it had just crossed.
      const ceiling = run.toolCallCap ?? workspace.maxToolCallsPerRun
      breaches.push(`it has made ${run.toolCalls} tool calls, past the ceiling of ${ceiling}`)
    }

    // Claim the run before cancelling it, exactly as the tick claims a task. `cancel` awaits the
    // child's exit, so by the time it returns the pump has very plausibly written the terminal row
    // -- and a run at its wall-clock limit is precisely the kind that is about to finish. An
    // unguarded status write then rewrote `succeeded` back to `stopping`: the slave read busy
    // forever, the task was never released, the failure streak never saw it, and a
    // `guardrail.tripped` announced a cancellation of a run that had succeeded. Nothing recovered
    // it in-process, because `stopping` is not swept.
    const claimed = await db.slaveRun.updateMany({
      where: { id: run.id, status: { in: [...SWEEPABLE] } },
      data: { status: 'stopping' },
    })
    if (claimed.count === 0) continue

    if (timedOutNow) timedOut.push(brandRunId(run.id))
    if (overCapNow) overToolCap.push(brandRunId(run.id))

    // A failure here makes the event louder rather than silencing it -- the third time this
    // milestone has needed saying.
    let cancelError: unknown = null
    try {
      // Resolved per run, not once for the whole pass (M12 Task 8; the pass-wide `resolveAdapter`
      // call this replaced predates a second provider being real dispatch): once Task 12 lands
      // Cursor, two runs in the same pass can be on different runtimes, and one adapter resolved
      // up front would call the WRONG one's `cancel` for the other. `?? 'claude_code'` is not a
      // choice among live options -- every run in this table was recorded before
      // `SlaveRun.provider` existed to be written, or (post-Task-8) was written by a dispatch that
      // already refused an unconfigured kind, so a `null` here is a historical fact (there was
      // only ever the one kind of run that could have produced it), never a guess.
      //
      // Resolved INSIDE this `try`, not before it: `resolveAdapter` can itself throw
      // `invalid_provider` for a kind this process no longer (or never did) have an adapter for.
      // A throw here must become `cancelError` like any other cancel failure, not escape the loop
      // -- an uncaught throw here would abort the whole sweep pass after the run above was already
      // claimed into `stopping`, wedging it there forever, since nothing else in this file sweeps
      // that status (see the comment above the claim, a few lines up).
      const adapter = resolveAdapter(deps.registry, run.provider ?? 'claude_code')
      await adapter.cancel(brandRunId(run.id))
    } catch (error) {
      cancelError = error
    }

    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: {
        guardrail: timedOutNow ? 'run_timeout' : 'tool_call_ceiling',
        detail:
          `cancelling this run: ${breaches.join('; ')}` +
          (cancelError === null
            ? ''
            : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`),
      },
    })
  }

  // After the dead-pid arm, deliberately: that arm concludes runs and releases their tasks itself,
  // and running this first would look at claims it is about to make current.
  const strandedClaims = await reconcileStrandedClaims(deps, workspace)

  return { timedOut, overToolCap, deadPids, strandedClaims, ...breakerMoves }
}

/** Which rung a beat climbed -- the three `SweepReport` keys, so the push site cannot misspell one. */
type BreakerMove = 'breakerSteered' | 'breakerConstrained' | 'breakerStopped'

/**
 * The previous beat's worktree fingerprint, per run, for THIS process.
 *
 * In memory and not in a column, deliberately. The question the clock asks is "did anything change
 * since the last beat", which needs the previous answer and nothing older; a column would be an
 * eighth one whose only job is to hold a value with a one-minute lifetime, written on every beat of
 * every live run. The cost of losing it -- a daemon restart, or the bound below -- is exactly one
 * beat read as `worktreeChanged: true`, which SUPPRESSES the no-progress arm rather than tripping
 * it (D17): no evidence is never evidence of a loop.
 */
const worktreeFingerprints = new Map<string, string>()

/** Past this many runs the fingerprint memory is dropped whole rather than grown. A long-lived
 *  daemon sees every run of every workspace it owns; one forgotten beat per run costs a minute. */
const FINGERPRINT_MEMORY_MAX = 500

/**
 * Deliver whatever steers are waiting (M51 R3, plan erratum E8).
 *
 * A pass of its own rather than part of `sweep`'s per-run loop, for two reasons the loop makes
 * unavoidable: `paused` is not in {@link SWEEPABLE}, and the loop skips a run with no pid -- which a
 * paused run never has, because pausing IS killing the child. And on every TICK rather than on the
 * beat: a steer that has been queued should land as soon as the run is actually parked.
 *
 * One indexed query over four columns, returning nothing on the overwhelming majority of ticks.
 * `deliverBreakerSteer` re-checks the whole marker under its own read, so a run that moved between
 * this query and that call is refused rather than resumed -- which is why every refusal here is
 * counted and dropped rather than logged: this pass calls the verb SPECULATIVELY.
 *
 * Returns how many steers it actually delivered, for a direct caller that wants to know; `sweep`
 * itself reports the three RUNGS and not this, because a delivery is the completion of a rung
 * already announced rather than a rung of its own.
 */
async function deliverBreakerSteers(deps: SweepDeps): Promise<number> {
  const parked = await db.slaveRun.findMany({
    where: {
      slave: { team: { workspaceId: deps.workspaceId } },
      status: 'paused',
      pauseReason: 'guardrail',
      breakerLevel: { not: 'none' },
      queuedMessage: { not: null },
      resumeRequestedAt: null,
    },
    select: { id: true },
  })

  let delivered = 0
  for (const run of parked) {
    const result = await deliverBreakerSteer(run.id)
    if (result.ok) delivered += 1
  }
  return delivered
}

/**
 * One beat of the behavioural breaker for one run (M51 R2).
 *
 * Returns which rung it climbed, or `null` for "nothing, not yet" -- which is the common case by a
 * wide margin: the daemon ticks about once a second and this beats once a minute per run.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **The beat gate.** `breakerBeatAt` within {@link BREAKER_BEAT_MS} returns immediately, before
 *    any query and before any probe. Without it a tripping run would climb steer -> constrain ->
 *    stop in three seconds, which is a kill with two extra events rather than a ladder.
 * 2. **The window**, one indexed read of this run's last {@link BREAKER_WINDOW} call/result/output
 *    rows (`ExecutionEvent`'s own `(runId, seq)` index).
 * 3. **The worktree clock**, on every beat -- which is once per run per minute, and that is the
 *    cost the design signed up for (a subprocess per run per TICK is what it refuses). Its answer
 *    is only consulted when nothing else already says the run moved, but the probe still RUNS,
 *    because it is what keeps the previous-beat fingerprint current: a skipped beat leaves a stale
 *    reading behind and costs the next quiet beat its comparison. It is also not skipped on the
 *    FIRST quiet beat, because `quiet` is the conjunction of all three clocks -- a beat cannot be
 *    recorded quiet without knowing what the worktree did, and guessing either way would either
 *    never accumulate a quiet beat or count one on a run that was committing.
 * 4. **The verdict**, from `detectBehaviour`, which is pure.
 * 5. **The act**, and exactly one of them.
 *
 * ## What is written, in every case
 *
 * `breakerBeatAt` and `breakerQuietBeats` are written on EVERY beat, including the ones that do
 * nothing: the beat clock is what paces the ladder and the quiet count is what debounces it, and a
 * beat that measured and wrote neither would leave both stale.
 *
 * ## Nothing here may throw
 *
 * This runs inside `sweep()`, inside a tick. The probe returns `null` on failure, every control
 * refusal is skipped, and a refusal is an ordinary outcome -- the run concluded between the read and
 * the act, which is a race this pass must lose gracefully rather than a fault.
 */
async function beatBreaker(
  deps: SweepDeps,
  run: {
    readonly id: string
    readonly taskId: string | null
    readonly slaveId: string
    readonly status: RunStatus
    readonly provider: string | null
    readonly worktreePath: string | null
    readonly startedAt: Date
    readonly breakerLevel: 'none' | 'steered' | 'constrained'
    readonly breakerTrips: number
    readonly breakerSteers: number
    readonly breakerBeatAt: Date | null
    readonly breakerQuietBeats: number
  },
): Promise<BreakerMove | null> {
  // `working` and nothing else (fix round 1, Critical 2). `SWEEPABLE` also holds `starting`,
  // `pause_requested` and `resuming`, and a run in any of them is not producing evidence about
  // anything -- but the one that MATTERS is `pause_requested`, which is where `steerRun` has just
  // put a run whose sentence is queued and whose pump has not reached the gate yet. One ordinary
  // beat there carries `trip === null`, and the level write below would de-escalate `steered` to
  // `none` -- after which `deliverBreakerSteer` refuses the run and its queued sentence is stranded
  // on a paused run that nothing will ever resume. A beat costs nothing to skip; a hung run costs a
  // human noticing.
  if (run.status !== 'working') return null

  const now = new Date()
  if (run.breakerBeatAt !== null && now.getTime() - run.breakerBeatAt.getTime() < BREAKER_BEAT_MS) return null

  const rows = await loadBreakerWindow(run.id)
  // The beat boundary. A run that has never beaten is measured from its own start, which is the
  // only honest reading of "since the last beat" for a first beat.
  const since = run.breakerBeatAt ?? run.startedAt
  const sinceRows = rows.filter((row) => row.ts > since)
  const trailingKey = [...rows].reverse().find((row) => row.row.kind === 'call')?.key ?? null
  const distinctKey = sinceRows.some((row) => row.row.kind === 'call' && row.key !== trailingKey)
  const output = sinceRows.some((row) => row.row.kind === 'output')

  // Step 3: the probe runs on EVERY beat, and its answer is only CONSULTED when nothing else
  // already says the run moved (fix round 1, Minor 8). The two halves used to be one: skipping the
  // probe on a busy beat also skipped recording that beat's fingerprint, so the first quiet beat
  // after a busy one compared against a reading two or more beats old, read "changed", and could
  // not start the `no_progress` count -- one extra beat of latency per busy-to-quiet transition,
  // in the safe direction but for no reason anybody had written down. `worktreeMoved` is what
  // refreshes the memory, so it is called either way and its answer discarded when the beat is
  // already known not to be quiet.
  const moved = await worktreeMoved(deps, run)
  const worktreeChanged = distinctKey || output ? true : moved

  const verdict = detectBehaviour({
    level: run.breakerLevel,
    trips: run.breakerTrips,
    steers: run.breakerSteers,
    quietBeats: run.breakerQuietBeats,
    rows: rows.map((row) => row.row),
    progress: { distinctKey, worktreeChanged, output },
  })

  // The beat clock and the debounce, from the verdict's own two flags and nowhere else: a
  // `suppressed` beat leaves the count exactly as it found it (a long build must neither accumulate
  // quiet beats nor discard the ones a wedged run had already earned), a `quiet` one increments, and
  // anything else resets. `endedAt: null` because a run that concluded under this pass keeps its
  // conclusion.
  await db.slaveRun.updateMany({
    where: { id: run.id, endedAt: null },
    data: {
      breakerBeatAt: now,
      ...quietBeatsWrite(verdict, run.breakerQuietBeats),
      // The de-escalation, written here because it is not an ACT: it is what the beat measured, it
      // announces nothing (de-escalation is silent), and the three arms below all write the level
      // themselves. `verdict.level` is a real `BreakerLevel` on this branch -- `'stop'` is only ever
      // returned with a trip.
      //
      // NOT on a `suppressed` beat (fix round 1, Important 3). The rung is left exactly as it was
      // found, for the same reason `breakerQuietBeats` is: a beat that ran inside a long tool call
      // measured nothing, and R2's step down is what a HEALTHY beat earns. Without this clause a
      // wedged run that happens to be inside one call at each beat walks constrained -> steered ->
      // none while measuring nothing at all.
      ...(verdict.trip === null && !verdict.suppressed
        ? { breakerLevel: verdict.level as 'none' | 'steered' | 'constrained' }
        : {}),
    },
  })

  if (verdict.trip === null) return null
  const trip = verdict.trip

  if (verdict.level === 'steered') {
    // The sweep raises the LEVEL and does NOT call `steerRun` (D15): the STEER rung is the
    // Supervisor's act, and this write is what lets `observe` see a run worth speaking to. The
    // Supervisor's own limits -- the halt demotion, the cooldown, `supervisorEnabled` -- then apply
    // for free to the one rung that puts words in front of a person's worker.
    const claimed = await db.slaveRun.updateMany({
      where: { id: run.id, endedAt: null },
      data: { breakerLevel: 'steered', breakerTrips: { increment: 1 } },
    })
    if (claimed.count === 0) return null
    await appendBreakerEvent(deps, run, 'steered', trip)
    return 'breakerSteered'
  }

  if (verdict.level === 'constrained') {
    // `constrainRun` writes the level itself, under the row lock that computes the cap, so the
    // sweep does not write it twice. The steer text rides along: a constrained worker that was
    // never told why would simply hit the ceiling in silence (spec R3).
    const constrained = await constrainRun(run.id, CONSTRAIN_GRACE_CALLS, steerTextFor(trip))
    if (!constrained.ok) return null
    if (!constrained.value.capSet) {
      // A RELAPSE: this run already carries a cap from an earlier rung and D16 forbids a second
      // grace. The rung is still climbed and still announced -- what would be wrong is letting an
      // operator read "constrained" as thirty fresh calls when the ceiling has not moved.
      console.warn(
        `[sweep] run ${run.id} was constrained again; its existing tool-call cap stands (no further grace)`,
      )
    }
    await db.slaveRun.updateMany({ where: { id: run.id, endedAt: null }, data: { breakerTrips: { increment: 1 } } })
    await appendBreakerEvent(deps, run, 'constrained', trip)
    return 'breakerConstrained'
  }

  return (await stopForBehaviour(deps, run, trip.kind, trip.detail)) ? 'breakerStopped' : null
}

/** The `breakerQuietBeats` write for this verdict -- the one place the three cases are spelled. */
function quietBeatsWrite(verdict: BreakerVerdict, current: number): { breakerQuietBeats?: number } {
  if (verdict.suppressed) return {}
  return { breakerQuietBeats: verdict.quiet ? current + 1 : 0 }
}

/** One `run.breaker` row. The two quiet rungs announce themselves here; the loud one does not --
 *  it is a `guardrail.tripped`, because one rung gets one name (D9). */
async function appendBreakerEvent(
  deps: SweepDeps,
  run: { readonly id: string; readonly taskId: string | null; readonly slaveId: string },
  level: 'steered' | 'constrained',
  trip: { readonly kind: string; readonly count: number; readonly detail: string },
): Promise<void> {
  await appendEvent({
    type: 'run.breaker',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'system',
    payload: { level, trip: trip.kind, count: trip.count, detail: trip.detail.slice(0, BREAKER_DETAIL_MAX) },
  })
}

/** `run.breaker.detail`'s own bound, restated at the one write site: the payload refuses anything
 *  longer, and a detector that one day names a very long tool key must not take a tick down. */
const BREAKER_DETAIL_MAX = 200

/**
 * The STOP rung: the sweep's own claim/cancel shape, verbatim from the hard-limit path above.
 *
 * **No terminal row**, for `run_timeout`'s exact reason: `pump.ts` concludes a run claimed into
 * `stopping` as `failed`, `verify.ts` releases the task to `rework` and charges an attempt, and the
 * existing `circuit_breaker` streak counts it -- so the two breakers compose. Writing `stopped` here
 * would make the run `terminal_uncounted` and the behavioural stop would never reach the failure
 * streak at all.
 *
 * `breakerLevel` is left at `constrained` on the concluded row, which is the record of how the run
 * ended.
 */
async function stopForBehaviour(
  deps: SweepDeps,
  run: {
    readonly id: string
    readonly taskId: string | null
    readonly slaveId: string
    readonly provider: string | null
  },
  trip: string,
  detail: string,
): Promise<boolean> {
  const claimed = await db.slaveRun.updateMany({
    where: { id: run.id, status: { in: [...SWEEPABLE] } },
    data: { status: 'stopping' },
  })
  if (claimed.count === 0) return false

  // The fingerprint memory is this run's last use of it.
  worktreeFingerprints.delete(run.id)

  // A failure here makes the event louder rather than silencing it, and `resolveAdapter` is inside
  // the `try` for the reason the hard-limit path gives: an uncaught throw would abort the sweep with
  // this run already claimed into `stopping`, which nothing in this file sweeps.
  let cancelError: unknown = null
  try {
    const adapter = resolveAdapter(deps.registry, (run.provider ?? 'claude_code') as 'claude_code' | 'cursor')
    await adapter.cancel(brandRunId(run.id))
  } catch (error) {
    cancelError = error
  }

  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'system',
    payload: {
      guardrail: 'behavioural_loop',
      detail:
        `cancelling this run: it is going in circles (${trip}, ${detail})` +
        (cancelError === null
          ? ''
          : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`),
    },
  })
  return true
}

/**
 * Did this run's worktree move since the last beat?
 *
 * `true` whenever there is no evidence either way (D17) -- no worktree at all (a planning run), a
 * probe that could not measure, or no previous fingerprint to compare with. A breaker that read a
 * failed measurement as a loop would stop healthy runs on a slow disk.
 */
async function worktreeMoved(
  deps: SweepDeps,
  run: { readonly id: string; readonly worktreePath: string | null },
): Promise<boolean> {
  if (run.worktreePath === null || run.worktreePath === '') return true
  const probe = deps.worktreeProbe ?? realWorktreeProbe
  let fingerprint: string | null = null
  try {
    fingerprint = await probe.fingerprint(run.worktreePath)
  } catch {
    // A probe that throws is a probe that did not measure. It is not allowed to take a tick down.
    fingerprint = null
  }
  if (fingerprint === null) return true

  const previous = worktreeFingerprints.get(run.id)
  if (worktreeFingerprints.size >= FINGERPRINT_MEMORY_MAX) worktreeFingerprints.clear()
  worktreeFingerprints.set(run.id, fingerprint)
  return previous === undefined || previous !== fingerprint
}

/** One row of the breaker's window, with the two things the domain's own shape does not carry: the
 *  timestamp the beat scope is measured against, and a call's key. */
interface WindowRow {
  readonly row: BreakerRow
  readonly ts: Date
  readonly key: string | null
}

/**
 * The run's last {@link BREAKER_WINDOW} call / result / output rows, OLDEST FIRST.
 *
 * Read newest-first and reversed, because "the last sixty" is the question and `(runId, seq)` is the
 * index that answers it. A pre-M51 `run.tool_call` row carries no `toolUseId` and no `argsHash`;
 * such a row is DROPPED rather than given an invented key, because a key two different calls could
 * share is exactly the collision (#377) this milestone's hash exists to remove -- and a dropped call
 * can only make the repeat arm quieter, never louder.
 */
async function loadBreakerWindow(runId: string): Promise<readonly WindowRow[]> {
  const rows = await db.executionEvent.findMany({
    where: { runId, type: { in: ['run_tool_call', 'run_tool_result', 'run_output'] } },
    orderBy: { seq: 'desc' },
    take: BREAKER_WINDOW,
    select: { seq: true, ts: true, type: true, payload: true },
  })

  const window: WindowRow[] = []
  for (const row of [...rows].reverse()) {
    const seq = Number(row.seq)
    const payload = (row.payload ?? {}) as Record<string, unknown>
    if (row.type === 'run_output') {
      window.push({ row: { kind: 'output', seq }, ts: row.ts, key: null })
      continue
    }
    const toolUseId = typeof payload['toolUseId'] === 'string' ? payload['toolUseId'] : null
    if (toolUseId === null) continue
    if (row.type === 'run_tool_call') {
      const argsHash = typeof payload['argsHash'] === 'string' ? payload['argsHash'] : null
      const name = typeof payload['name'] === 'string' ? payload['name'] : null
      if (argsHash === null || name === null) continue
      const key = `${name}:${argsHash}`
      window.push({ row: { kind: 'call', seq, toolUseId, key }, ts: row.ts, key })
      continue
    }
    const outcome = payload['outcome'] === 'error' ? 'error' : 'ok'
    const errorClass = typeof payload['errorClass'] === 'string' ? payload['errorClass'] : null
    window.push({ row: { kind: 'result', seq, toolUseId, outcome, errorClass }, ts: row.ts, key: null })
  }
  return window
}

/**
 * Concludes a run whose process is gone, from inside a running daemon (spec §3.3).
 *
 * Guarded the same way the cancel path is: if the pump got there first, its terminal row stands.
 */
async function concludeDeadRun(
  deps: SweepDeps,
  run: {
    readonly id: string
    readonly taskId: string | null
    readonly slaveId: string
    readonly pid: number | null
    readonly kind: 'implementation' | 'review' | 'planning'
  },
): Promise<void> {
  const now = new Date()
  const concluded = await db.slaveRun.updateMany({
    where: { id: run.id, status: { in: [...SWEEPABLE] } },
    data: { status: 'failed', terminalAt: now, endedAt: now },
  })
  if (concluded.count === 0) return

  // A `planning` run (M8b) has no task to release. A `review` run gets ONLY its claim back and
  // leaves the task in `reviewing` -- see `reconcileOrphans`' own release for why `rework` would be
  // both a lie and an implementation attempt spent on work nobody judged wrong (M41 Task 3b).
  if (run.taskId !== null) {
    await db.task.updateMany({
      where: { id: run.taskId, activeRunId: run.id },
      data: run.kind === 'review' ? { activeRunId: null } : { status: 'rework', activeRunId: null },
    })
  }

  await appendEvent({
    type: 'run.failed',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'system',
    payload: { reason: `the run's process (pid ${run.pid}) is gone but the run never concluded` },
  })
}
