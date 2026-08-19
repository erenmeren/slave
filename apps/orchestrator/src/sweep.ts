import { type PrismaClient, prisma as sharedPrisma } from '@ai-team-os/db/client'
import { runId as brandRunId, type RunId, type RunStatus, type WorkspaceId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { AgentRuntimeAdapter } from '@ai-team-os/providers'

export interface SweepDeps {
  readonly workspaceId: WorkspaceId
  readonly adapter: AgentRuntimeAdapter
  /**
   * Row reads and writes go through this; it defaults to the shared client and exists so a caller
   * can prove a property across a process boundary. Events always go through `appendEvent`
   * regardless — that is the single write gate (ADR 0003), and it now serialises appends
   * process-wide (M2's `seq` ordering depends on it), so it is deliberately not parameterised.
   */
  readonly prisma?: PrismaClient
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
const ORPHANABLE: readonly RunStatus[] = ['starting', 'working', 'pause_requested', 'resuming', 'stopping']

/**
 * The statuses the per-tick sweep may act on. `stopping` is excluded here but not above: a run
 * already being cancelled must not be cancelled again on the next tick, or a run that takes a
 * moment to die is re-announced once per second, forever, into an append-only log — the hazard
 * §3.2 spends three paragraphs on for the halt command. The orphan pass still fails it if its
 * process is gone, which is how a run that never finished dying is eventually concluded.
 */
const SWEEPABLE: readonly RunStatus[] = ['starting', 'working', 'pause_requested', 'resuming']

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
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
  const db = deps.prisma ?? sharedPrisma

  const runs = await db.agentRun.findMany({
    where: { status: { in: [...ORPHANABLE] }, task: { workspaceId: deps.workspaceId } },
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
    await db.task.updateMany({
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
    failed += 1
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
  const db = deps.prisma ?? sharedPrisma
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId } })
  const runs = await db.agentRun.findMany({
    where: { status: { in: [...SWEEPABLE] }, task: { workspaceId: deps.workspaceId } },
  })

  const timedOut: RunId[] = []
  const overToolCap: RunId[] = []
  const deadPids: RunId[] = []

  for (const run of runs) {
    if (!isAlive(run.pid)) {
      deadPids.push(brandRunId(run.id))
      continue
    }

    const breaches: string[] = []
    if (Date.now() - run.startedAt.getTime() > workspace.runTimeoutMs) {
      timedOut.push(brandRunId(run.id))
      breaches.push(`it has been running longer than the workspace's ${workspace.runTimeoutMs}ms limit`)
    }
    if (run.toolCalls > workspace.maxToolCallsPerRun) {
      overToolCap.push(brandRunId(run.id))
      breaches.push(`it has made ${run.toolCalls} tool calls, past the ceiling of ${workspace.maxToolCallsPerRun}`)
    }
    if (breaches.length === 0) continue

    // Cancel first, and let a failure make the event louder rather than swallowing it. A cancel
    // that throws has silenced everything after it twice in this milestone already.
    let cancelError: unknown = null
    try {
      await deps.adapter.cancel(brandRunId(run.id))
    } catch (error) {
      cancelError = error
    }

    // `stopping` is what stops the next tick doing this again. The run is still non-terminal, so
    // the agent stays busy while it dies -- which is correct: it has not released anything yet.
    await db.agentRun.update({ where: { id: run.id }, data: { status: 'stopping' } })

    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      agentId: run.agentId,
      runId: run.id,
      actor: 'system',
      payload: {
        guardrail: timedOut.includes(brandRunId(run.id)) ? 'run_timeout' : 'tool_call_ceiling',
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
