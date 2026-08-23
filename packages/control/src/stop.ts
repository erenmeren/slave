import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { killWithEscalation } from './kill.js'
import type { ControlRefusal } from './refusal.js'

export async function requestStop(runId: string, requestedBy: string): Promise<Result<void, ControlRefusal>> {
  // Scoped through `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and
  // `agent -> team -> workspace` is the only linkage such a run has to a workspace.
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: { include: { team: true } } },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })

  // Claim the stop intent before the kill, not after (M5 live-gate finding 2). In the CLI this
  // process owns the pump it is about to kill, so the two writes below never race one another --
  // but a web stop's kill wakes the *daemon's* pump, in another process, and that pump can
  // observe the dead child and conclude the run before this function reaches its own conclusion.
  // `stopping` alone is not a safe enough signal for the pump to act on (gate-fix B review round
  // 1, Critical 2): the guardrail sweep claims the same status ahead of its own cancel, for a
  // timed-out or over-the-tool-cap run that must still conclude `failed`. `stopRequestedBy` /
  // `stopRequestedAt` are the record that distinguishes an *operator's* stop -- only this function
  // writes them -- and they are what lets the pump's stream-ended path (`pump.ts`) recognise one
  // and write `stopped` itself, naming the requester, rather than reporting a plain crash.
  // Whichever side's conditioned `updateMany` lands first, the row ends up `stopped` either way.
  // Conditioned like every other write here: an already-terminal run's claim is a no-op, not a
  // demotion. Left set after the run concludes -- historical record of who asked, nothing reads
  // them as live state, so there is nothing to clear.
  const stopRequestedAt = new Date()
  await prisma.agentRun.updateMany({
    where: { id: run.id, endedAt: null },
    data: { status: 'stopping', stopRequestedBy: requestedBy, stopRequestedAt },
  })

  // The adapter's own kill escalates; a CLI cancel that only asks politely is strictly
  // weaker than the thing it replaces, which reopens a thinner version of the Task 15 carry
  // it was written to close.
  const signalled = await killWithEscalation(run.pid)
  const now = new Date()
  // Not a refusal on an already-concluded run -- the CLI never refused `cancel` on one, and
  // `endedAt: null` is the idempotence guard that makes a second call a no-op that still
  // reports ok, rather than a `wrong_status` refusal. Keep that contract: `requestStop` on a
  // run that finished a moment ago is not an error, it is nothing left to do.
  //
  // The pump may have already won this race and written `stopped` itself (`concluded.count` is
  // then 0) -- `run.stopped` is then already in the log, so this function's own emit below stays
  // conditioned on having actually written the row, or a web stop would double-announce itself.
  const concluded = await prisma.agentRun.updateMany({
    where: { id: run.id, endedAt: null },
    data: { status: 'stopped', terminalAt: now, endedAt: now },
  })
  // `blocked`, not `rework`: the help and the README both say cancel stops a run for good, and
  // `rework` is startable -- the next tick would hand the task to a fresh agent on the same
  // worktree, with `attempt` never incremented so repeated cancels never reach the cap. The
  // spec does not decide this (§11 says only "kill and preserve the worktree"); shipping a
  // command that says one thing and does another is the part that is not a judgement call.
  // A `planning` run (M8b) has no task to release -- nothing else here needs to change for it.
  if (run.taskId !== null) {
    await prisma.task.updateMany({
      where: { id: run.taskId, activeRunId: run.id },
      data: { status: 'blocked', activeRunId: null },
    })
  }
  if (concluded.count > 0) {
    await appendEvent({
      type: 'run.stopped',
      workspaceId: run.agent.team.workspaceId,
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
  }
  return ok(undefined)
}
