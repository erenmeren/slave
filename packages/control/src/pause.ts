import { writeFileSync } from 'node:fs'
import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, type Result, err, ok, runId as brandRunId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { runFilePaths } from './paths.js'
import type { ControlRefusal } from './refusal.js'

const PAUSABLE_STATUSES = ['starting', 'working', 'resuming'] as const

/** `AgentRun.pauseReason`'s categories (spec §6): who -- or what -- asked for the pause. */
export type PauseCategory = 'human' | 'guardrail' | 'emergency_stop'

export async function requestPause(
  runId: string,
  requestedBy: string,
  category: PauseCategory = 'human',
): Promise<Result<void, ControlRefusal>> {
  // Scoped through `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and
  // `agent -> team -> workspace` is the only linkage such a run has to a workspace -- the same
  // derivation `pauseActiveRuns` below uses to find it in the first place.
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: { include: { team: true } } },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })

  // Write the flag; the gate denies the next tool call and the *stream owner* follows the rest
  // of the protocol. A CLI invocation has no handle on the child and no view of its stream, so
  // it cannot await the outcome -- the daemon's pump is what observes the deny and records
  // `run.paused`. Spec §11 says "write the flag, follow the protocol"; this is the half a
  // separate process can perform.

  // Claimed, not written. `pause_requested` is a non-terminal status, so pausing a run that
  // already finished puts a *concluded* run back into `activeRuns`, makes its agent look busy,
  // and leaves it for the next restart's orphan sweep to flip to `failed` -- corrupting the
  // record of a run that actually succeeded.
  const claimed = await prisma.agentRun.updateMany({
    where: { id: run.id, status: { in: [...PAUSABLE_STATUSES] } },
    // `pauseReason` is the *category*: an operator asked, a guardrail tripped, or an emergency
    // stop engaged. Task 12 carried the column forward as one nothing wrote; Task 9 is the first
    // caller to pass anything but the human default.
    data: { status: 'pause_requested', pauseReason: category },
  })
  if (claimed.count === 0) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: PAUSABLE_STATUSES })
  }

  // The same derivation the tick used to tell the child where its flag is -- re-deriving it as
  // a second literal is how the two come to disagree, and a gate reading a path nobody writes
  // means an operator watches a "pausing" run keep working (spec §5.5's named failure).
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.agent.team.workspaceId } })
  const { pauseFlagPath } = runFilePaths(workspace.repoPath, brandRunId(run.id))
  writeFileSync(pauseFlagPath, `${requestedBy}\n`)
  await appendEvent({
    type: 'run.pause_requested',
    workspaceId: run.agent.team.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'human',
    payload: { requestedBy },
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
    const result = await requestPause(run.id, requestedBy, category)
    if (result.ok) {
      requested.push(run.id)
    } else {
      refused.push(run.id)
    }
  }
  return { requested, refused }
}
