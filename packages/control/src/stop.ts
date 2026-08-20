import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { killWithEscalation } from './kill.js'
import type { ControlRefusal } from './refusal.js'

export async function requestStop(runId: string, requestedBy: string): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { task: true } })
  if (run === null) return err({ kind: 'run_not_found', runId })

  // The adapter's own kill escalates; a CLI cancel that only asks politely is strictly
  // weaker than the thing it replaces, which reopens a thinner version of the Task 15 carry
  // it was written to close.
  const signalled = await killWithEscalation(run.pid)
  const now = new Date()
  // Not a refusal on an already-concluded run -- the CLI never refused `cancel` on one, and
  // `endedAt: null` is the idempotence guard that makes a second call a no-op that still
  // reports ok, rather than a `wrong_status` refusal. Keep that contract: `requestStop` on a
  // run that finished a moment ago is not an error, it is nothing left to do.
  await prisma.agentRun.updateMany({
    where: { id: run.id, endedAt: null },
    data: { status: 'stopped', terminalAt: now, endedAt: now },
  })
  // `blocked`, not `rework`: the help and the README both say cancel stops a run for good, and
  // `rework` is startable -- the next tick would hand the task to a fresh agent on the same
  // worktree, with `attempt` never incremented so repeated cancels never reach the cap. The
  // spec does not decide this (§11 says only "kill and preserve the worktree"); shipping a
  // command that says one thing and does another is the part that is not a judgement call.
  await prisma.task.updateMany({
    where: { id: run.taskId, activeRunId: run.id },
    data: { status: 'blocked', activeRunId: null },
  })
  await appendEvent({
    type: 'run.stopped',
    workspaceId: run.task.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'human',
    payload: {
      reason: signalled
        ? `cancelled by ${requestedBy}`
        : `cancelled by ${requestedBy}; no live process to signal (pid ${String(run.pid)})`,
    },
  })
  return ok(undefined)
}
