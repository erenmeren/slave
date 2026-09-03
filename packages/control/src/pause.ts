import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, type Result, err, ok, runId as brandRunId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { signalPause } from '@ai-team-os/providers'
import { runFilePaths } from './paths.js'
import type { Principal } from './principal.js'
import { type ControlRefusal, refusalText } from './refusal.js'

const PAUSABLE_STATUSES = ['starting', 'working', 'resuming'] as const

/** `AgentRun.pauseReason`'s categories (spec §6): who -- or what -- asked for the pause. */
export type PauseCategory = 'human' | 'guardrail' | 'emergency_stop'

export async function requestPause(
  runId: string,
  requestedBy: string,
  category: PauseCategory = 'human',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  // Scoped through `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and
  // `agent -> team -> workspace` is the only linkage such a run has to a workspace -- the same
  // derivation `pauseActiveRuns` below uses to find it in the first place.
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: { include: { team: true } } },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })

  // Signal the pause; the gate denies the next tool call and the *stream owner* follows the rest
  // of the protocol. A CLI invocation has no handle on the child and no view of its stream, so
  // it cannot await the outcome -- the daemon's pump is what observes the deny and records
  // `run.paused`. Spec §11 says "write the flag, follow the protocol"; this is the half a
  // separate process can perform.
  //
  // Signaled through `packages/providers`' `signalPause`, not written here directly: pausing is
  // a cross-process control signal (this function runs in the CLI, in a web request, and in the
  // daemon alike), so there is no live `AgentRuntimeAdapter` instance available to call --
  // `signalPause` is the stateless half of the provider seam that exists for exactly that
  // reason (M12 Task 3's fix round; see its report for why the adapter-instance route the task
  // was originally specified with does not work).

  // Claim and read in ONE statement (M15 spec §3 B1): `priorStatus` must be the status this claim
  // actually interrupted, not the status an earlier SELECT happened to see. `FOR UPDATE` orders a
  // concurrent claimant behind this one; the RETURNING carries the pre-claim value out. Claimed,
  // not written: `pause_requested` is a non-terminal status, so pausing a run that already
  // finished puts a *concluded* run back into `activeRuns`, makes its agent look busy, and leaves
  // it for the next restart's orphan sweep to flip to `failed` -- corrupting the record of a run
  // that actually succeeded.
  //
  // `pauseReason` is the *category*: an operator asked, a guardrail tripped, or an emergency stop
  // engaged. Task 12 carried the column forward as one nothing wrote; Task 9 is the first caller
  // to pass anything but the human default.
  const claimedRows = await prisma.$queryRaw<{ priorStatus: (typeof PAUSABLE_STATUSES)[number] }[]>`
    UPDATE "AgentRun" AS r
    SET status = 'pause_requested'::"RunStatus", "pauseReason" = ${category}::"PauseReason"
    FROM (SELECT id, status FROM "AgentRun" WHERE id = ${run.id} FOR UPDATE) AS prev
    WHERE r.id = prev.id AND prev.status = ANY(${[...PAUSABLE_STATUSES]}::text[]::"RunStatus"[])
    RETURNING prev.status AS "priorStatus"`
  const priorStatus = claimedRows[0]?.priorStatus
  if (priorStatus === undefined) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: PAUSABLE_STATUSES })
  }

  // The same derivation the tick used to tell the child where its flag is -- re-deriving it as
  // a second literal is how the two come to disagree, and a gate reading a path nobody writes
  // means an operator watches a "pausing" run keep working (spec §5.5's named failure).
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.agent.team.workspaceId } })
  const { pauseFlagPath } = runFilePaths(workspace.repoPath, brandRunId(run.id))
  // The run's OWN provider (M12 Task 8), not a process-wide constant: `run` is already loaded
  // above, so this is a lookup, not a new query. `?? 'claude_code'` is a historical-fact backfill
  // for runs recorded before `AgentRun.provider` existed to be written, not a guess among live
  // options -- the same discipline `resume.ts`/`sweep.ts` apply to their own `run.provider ??
  // 'claude_code'`. Signaling the wrong provider's flag file would pause nothing for a real run on
  // a second runtime.
  try {
    await signalPause(run.provider ?? 'claude_code', { pauseFlagPath, pid: run.pid }, requestedBy)
  } catch (error) {
    // A claim that cannot be signalled is released (M13 Decision 5). Without this the run parks in
    // `pause_requested` -- a non-terminal status meaning "an operator asked and the signal was
    // sent" -- with nothing coming: it looks paused to the panel, it is excluded from nothing, and
    // the only thing that will ever touch it again is a restart's orphan sweep.
    //
    // Conditional on `pause_requested` so a race that already moved the run past the claim (a
    // concurrent `requestStop`, the pump concluding it) keeps ITS outcome; this rollback only ever
    // undoes a claim that is still standing, and only ever to the status it displaced. That is the
    // `pause_unsignalled` edge in `packages/domain`'s run machine.
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: 'pause_requested' },
      data: { status: priorStatus, pauseReason: run.pauseReason },
    })
    return err({
      kind: 'pause_unsignalled',
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  // The `appendEvent` stays AFTER the try/catch: a pause that was rolled back must not announce
  // itself.
  await appendEvent({
    type: 'run.pause_requested',
    workspaceId: run.agent.team.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'human',
    payload: { requestedBy },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}

export interface PauseFanoutReport {
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/**
 * Request pause on every active run in the workspace; refusals are expected noise (spec §6).
 *
 * A run that lost a race in between `loadWorld`'s snapshot and this call -- concluded, or already
 * `pause_requested` by an operator -- is exactly the ordinary case a guardrail breach's fan-out
 * runs into, not a bug: `requestPause` itself is what tells the two apart, and its refusal is what
 * belongs in `refused` rather than an exception unwinding the whole fan-out over one run that
 * finished a moment early.
 */
export async function pauseActiveRuns(
  workspaceId: string,
  requestedBy: string,
  category: PauseCategory,
): Promise<PauseFanoutReport> {
  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and scoping through `Task` would silently drop it from an emergency stop's
  // fan-out -- exactly the run a halt most needs to reach, since it is still spending money.
  const runs = await prisma.agentRun.findMany({
    where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, agent: { team: { workspaceId } } },
    select: { id: true },
  })

  const requested: string[] = []
  const refused: string[] = []
  for (const run of runs) {
    // Per-run try/catch, not one around the loop (M12 Task 3 review, ruled to Task 12). Until this
    // milestone there was no reachable throw at all: `signalPause` only ever dispatched
    // `'claude_code'`, whose branch just writes a file. A second provider changes that -- Cursor's
    // pause ENDS A PROCESS, and ending a process can fail in ways writing a file cannot: no pid
    // was ever recorded (`signalCursorPause` refuses that outright rather than reporting a pause
    // it did not perform), or the flag write itself fails. An exception escaping here would
    // abandon the rest of the fan-out, leaving every LATER run in the workspace unsignaled by an
    // emergency stop -- a silent hole in the strongest guarantee this system makes, and precisely
    // when it matters most. A run whose pause could not be signalled belongs in `refused`
    // alongside the ones that lost a benign status race, which is what the caller already reports;
    // what must never happen is the loop stopping early and nothing saying it did.
    //
    // EVERY refusal is logged, not just a thrown one (M13 Task 4 review I1). Since Task 4 the
    // pid-less Cursor case comes back as a `pause_unsignalled` refusal rather than an exception,
    // so the `catch` below is no longer the path it takes -- and `PauseFanoutReport` carries ids
    // only, which the CLI renders as "N already concluding". Logging just the throw would mean an
    // operator hits emergency stop, a Cursor run is not paused at all, and the one line that could
    // have said so never printed. `refusalText` is what keeps the two kinds of `refused`
    // distinguishable now: a benign status race reads "run X is paused; this needs one of ...",
    // an unsignalled pause reads "the pause could not be signalled to run X: ...". The fan-out's
    // log is thereby a complete account of every run it did NOT pause, which for an emergency stop
    // is the only account worth having.
    try {
      const result = await requestPause(run.id, requestedBy, category)
      if (result.ok) {
        requested.push(run.id)
      } else {
        console.error(`[pause] ${refusalText(result.error)}`)
        refused.push(run.id)
      }
    } catch (error) {
      console.error(`[pause] failed to signal pause for run ${run.id}:`, error)
      refused.push(run.id)
    }
  }
  return { requested, refused }
}
