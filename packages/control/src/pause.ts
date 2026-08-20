import { writeFileSync } from 'node:fs'
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok, runId as brandRunId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { runFilePaths } from './paths.js'
import type { ControlRefusal } from './refusal.js'

const PAUSABLE_STATUSES = ['starting', 'working', 'resuming'] as const

export async function requestPause(runId: string, requestedBy: string): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { task: true } })
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
    // `pauseReason` is the *category*, and this is the one place that knows it: an operator
    // asked. Task 12 carried it forward as a column nothing wrote.
    data: { status: 'pause_requested', pauseReason: 'human' },
  })
  if (claimed.count === 0) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: PAUSABLE_STATUSES })
  }

  // The same derivation the tick used to tell the child where its flag is -- re-deriving it as
  // a second literal is how the two come to disagree, and a gate reading a path nobody writes
  // means an operator watches a "pausing" run keep working (spec §5.5's named failure).
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.task.workspaceId } })
  const { pauseFlagPath } = runFilePaths(workspace.repoPath, brandRunId(run.id))
  writeFileSync(pauseFlagPath, `${requestedBy}\n`)
  await appendEvent({
    type: 'run.pause_requested',
    workspaceId: run.task.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'human',
    payload: { requestedBy },
  })
  return ok(undefined)
}
