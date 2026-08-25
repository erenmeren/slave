import { prisma as db } from '@ai-team-os/db/client'
import { runId as brandRunId, type RunId, type RunStatus, type WorkspaceId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'
import type { AdapterRegistry } from '@ai-team-os/providers'
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
}

export interface SweepReport {
  readonly timedOut: readonly RunId[]
  readonly overToolCap: readonly RunId[]
  readonly deadPids: readonly RunId[]
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

/**
 * Whether the process is still there.
 *
 * `process.kill(pid, 0)` sends no signal and only asks. Never an "is the run old" heuristic — that
 * is the wall-clock timeout's job, and conflating the two makes a slow run look like a dead one.
 *
 * The known imprecision, stated rather than left to be discovered: pids are reused, so a recycled
 * pid reads as alive and the run is left alone. That is the safe direction — the sweep's wall-clock
 * half catches it eventually — but it means "alive" here is "something with that pid is alive".
 */
function isAlive(pid: number | null): boolean {
  // 0 and negatives select a process *group*, not a process: `kill(0, 0)` signals the caller's own
  // group and always succeeds, so a run recorded with pid 0 would be permanently unreconcilable.
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // `EPERM` is positive evidence of life: POSIX returns it only for a process that *exists* but
    // is not ours. Reading it as dead is the unsafe direction, and it is reachable the moment the
    // daemon drops privileges or shares a pid namespace -- it would fail a run whose agent is very
    // much alive, release its task, and start a second agent into the same worktree.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether a tick has run in this process.
 *
 * `reconcileOrphans` treats a non-terminal run with no pid as an orphan, because nothing will ever
 * conclude it -- but that same shape exists legitimately for a few milliseconds inside every
 * `startRun`, between creating the row and recording the pid. Reconciling while a tick is in
 * flight therefore fails a run seconds from spawning, releases its task to `rework`, and the next
 * tick adopts the live run's worktree with a second agent: two agents, one branch, which is the
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
 * legitimately for a few milliseconds inside every `startRun`, between creating the `AgentRun` row
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


  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and this pass exists precisely to fail an orphan whichever kind it is.
  const runs = await db.agentRun.findMany({
    where: { status: { in: [...ORPHANABLE] }, agent: { team: { workspaceId: deps.workspaceId } } },
  })

  let failed = 0
  for (const run of runs) {
    if (isAlive(run.pid)) continue

    const now = new Date()
    await db.agentRun.update({
      where: { id: run.id },
      // `terminalAt` matters: it is the key `loadWorld` orders the failure streak by, and an orphan
      // concluded without it sorts by `startedAt` instead — the mixed-clock case Task 10 carried.
      data: { status: 'failed', terminalAt: now, endedAt: now },
    })

    // Release the task the run was holding. Task 13 sets `status: running` and `activeRunId` when
    // it starts one; failing the run and leaving the task pointing at it strands the task busy
    // forever, and nothing else in the milestone reconciles *tasks*.
    //
    // No attempt is counted. A daemon that died is not the agent failing, and counting it would let
    // a crash-looping daemon exhaust every task's attempts and fail the lot — losing real work to
    // an infrastructure problem. Same reasoning as Task 14's non-agent verify outcomes.
    //
    // A `planning` run (M8b) has no task to release -- `taskId` is `null` and there is nothing
    // else in this block for it.
    const task = run.taskId === null ? null : await db.task.findUniqueOrThrow({ where: { id: run.taskId } })
    const released =
      run.taskId === null
        ? { count: 0 }
        : await db.task.updateMany({
            where: { id: run.taskId, activeRunId: run.id },
            data: { status: 'rework', activeRunId: null },
          })

    await appendEvent({
      type: 'run.failed',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      agentId: run.agentId,
      runId: run.id,
      actor: 'system',
      payload: {
        reason:
          run.pid === null
            ? 'the run was never recorded as started, and no process is tracking it: it was orphaned by a restart'
            : `the run's process (pid ${run.pid}) is gone but the run never concluded: it was orphaned by a restart`,
      },
    })
    if (released.count > 0 && task !== null) {
      // §13: no failure is silent. `failToStart` and `advance` both announce a task they park in
      // `rework`; a reader would otherwise see a run fail with no record of the task going back
      // into the queue. Only when this pass is what released it.
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
  // reason a dead daemon does not count against a run's orphan: a crashed process is not the agent
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
 * One pass over this workspace's live runs, per tick (spec §3.3).
 *
 * Reports a dead pid but does not act on it: concluding an orphan is `reconcileOrphans`' job, and
 * keeping the two apart means the startup pass and the per-tick pass cannot come to disagree about
 * what a dead pid means.
 */
export async function sweep(deps: SweepDeps): Promise<SweepReport> {
  // Resolved once for the whole pass -- `resolveAdapter` is the single place `'claude_code'` is
  // named (M12 Task 5). `reconcileOrphans` above never needs this: it only ever writes rows, it
  // never calls the adapter.
  const adapter = resolveAdapter(deps.registry)
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId } })
  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and the timeout/tool-cap guardrails below must still reach it.
  const runs = await db.agentRun.findMany({
    where: { status: { in: [...SWEEPABLE] }, agent: { team: { workspaceId: deps.workspaceId } } },
  })

  const timedOut: RunId[] = []
  const overToolCap: RunId[] = []
  const deadPids: RunId[] = []

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
    const overCapNow = run.toolCalls > workspace.maxToolCallsPerRun
    if (!timedOutNow && !overCapNow) continue

    const breaches: string[] = []
    if (timedOutNow) breaches.push(`it has been running longer than the workspace's ${workspace.runTimeoutMs}ms limit`)
    if (overCapNow) {
      breaches.push(`it has made ${run.toolCalls} tool calls, past the ceiling of ${workspace.maxToolCallsPerRun}`)
    }

    // Claim the run before cancelling it, exactly as the tick claims a task. `cancel` awaits the
    // child's exit, so by the time it returns the pump has very plausibly written the terminal row
    // -- and a run at its wall-clock limit is precisely the kind that is about to finish. An
    // unguarded status write then rewrote `succeeded` back to `stopping`: the agent read busy
    // forever, the task was never released, the failure streak never saw it, and a
    // `guardrail.tripped` announced a cancellation of a run that had succeeded. Nothing recovered
    // it in-process, because `stopping` is not swept.
    const claimed = await db.agentRun.updateMany({
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
      await adapter.cancel(brandRunId(run.id))
    } catch (error) {
      cancelError = error
    }

    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      agentId: run.agentId,
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

  return { timedOut, overToolCap, deadPids }
}

/**
 * Concludes a run whose process is gone, from inside a running daemon (spec §3.3).
 *
 * Guarded the same way the cancel path is: if the pump got there first, its terminal row stands.
 */
async function concludeDeadRun(
  deps: SweepDeps,
  run: { readonly id: string; readonly taskId: string | null; readonly agentId: string; readonly pid: number | null },
): Promise<void> {
  const now = new Date()
  const concluded = await db.agentRun.updateMany({
    where: { id: run.id, status: { in: [...SWEEPABLE] } },
    data: { status: 'failed', terminalAt: now, endedAt: now },
  })
  if (concluded.count === 0) return

  // A `planning` run (M8b) has no task to release.
  if (run.taskId !== null) {
    await db.task.updateMany({
      where: { id: run.taskId, activeRunId: run.id },
      data: { status: 'rework', activeRunId: null },
    })
  }

  await appendEvent({
    type: 'run.failed',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'system',
    payload: { reason: `the run's process (pid ${run.pid}) is gone but the run never concluded` },
  })
}
