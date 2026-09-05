import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { capabilitiesOf, type ProviderKind } from '@slave-of-ai/providers'
import { isAlive } from './kill.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

const RESUMABLE_STATUSES = ['paused'] as const

/**
 * Whether this run's runtime can be resumed at all -- the refusal, or `null` for "carry on".
 *
 * `canResumeSession` is one of the two capabilities spec §4 makes the pause protocol turn on, and
 * before the final review it had no reader anywhere: a provider could declare that a stopped
 * session cannot be continued and this function would still record the intent, hand it to a tick,
 * and let the adapter discover the truth with a run already claimed and an operator already told
 * the resume was accepted. Reading the capability here is what makes the declaration mean
 * something.
 *
 * Pure, and separate from `requestResume`, because it is the only part of that check that can be
 * tested honestly: both shipped providers declare `canResumeSession: true`, so no database state
 * produces this refusal today, and the alternative to a pure predicate is mocking `capabilitiesOf`
 * -- which would test the mock. See `test/resume-refusal.test.ts`.
 */
export function resumeRefusal(runId: string, provider: ProviderKind): ControlRefusal | null {
  return capabilitiesOf(provider).canResumeSession ? null : { kind: 'provider_cannot_resume', runId, provider }
}

/**
 * Records that someone wants this run continued — and nothing else.
 *
 * **The status stays `paused`, and that is the whole design.** The orphan sweep
 * (`apps/orchestrator/src/sweep.ts`) fails every non-terminal, non-`paused` run whose pid is dead,
 * so a run sitting in `resuming` with no process is *exactly* the orphan shape: a web request that
 * claimed `paused -> resuming` and then handed the spawn to some other process would leave the run
 * one sweep away from being failed, with its checkpoint gone and its task released to a second
 * slave. So the web writes an intent; the process that can own a child — the daemon's tick, or the
 * CLI — claims and spawns in one step. See {@link claimResume}.
 *
 * The refusals are the CLI's own, in the CLI's order minus one: a run that is plainly not paused is
 * told *that* rather than "there is no checkpoint". A working run has no checkpoint either, and the
 * checkpoint refusal would send an operator looking for a missing row that was never supposed to
 * exist yet. The claim below still owns the race.
 */
export async function requestResume(
  runId: string,
  rawMessage: string | null,
  requestedBy: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  // An empty or whitespace-only message is the "say nothing" case, not a literal instruction: the
  // adapter would otherwise spawn the child with `-p ''` (see `updateQueuedMessage`'s doc comment
  // for the same normalization on the panel's save path).
  const message = rawMessage === null || rawMessage.trim() === '' ? null : rawMessage
  // Scoped through `slave -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and
  // `slave -> team -> workspace` is the only linkage such a run has to a workspace.
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    include: { slave: { include: { team: true } } },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })

  // A halt is raised by a pause-gate failure or an unverifiable workspace (spec §13.1, §8), so
  // resuming into one relaunches an slave whose gate may still be broken -- the recurrence the halt
  // exists to bound. Refused here rather than only at the daemon, because an intent recorded now
  // would be picked up the instant an operator cleared the halt, by which time nobody remembers
  // this request was made against a halted workspace.
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.slave.team.workspaceId } })
  if (workspace.haltedReason !== null) {
    return err({ kind: 'workspace_halted', workspaceId: workspace.id, reason: workspace.haltedReason })
  }

  // Ahead of the status and checkpoint checks on purpose: those two ask whether THIS run is in a
  // shape that can be resumed, and there is no point answering that for a runtime on which no run
  // ever can be. `?? 'claude_code'` is the same historical-fact backfill the branch applies at
  // `apps/orchestrator/src/resume.ts`, `sweep.ts` and `pause.ts` -- a null here means the row
  // predates `SlaveRun.provider` existing to be written, and before M12 there was no second
  // adapter that could have produced it.
  const cannotResume = resumeRefusal(run.id, run.provider ?? 'claude_code')
  if (cannotResume !== null) return err(cannotResume)

  if (run.status !== 'paused') {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: RESUMABLE_STATUSES })
  }

  // Checked before the intent is recorded, not left for the daemon to discover: a run with no
  // checkpoint cannot be resumed by anyone, and an intent nobody can execute is a button that
  // reports success and then does nothing forever.
  const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: run.id }, select: { id: true } })
  if (checkpoint === null) return err({ kind: 'no_checkpoint', runId: run.id })

  // The second lock (M13 Decision 3). Task 1's pump ordering is what makes this unreachable in a
  // correct system: `paused` is written only once `killWithEscalation` has returned, and it
  // SIGKILLs at the grace deadline. Checking anyway is cheap and turns a future ordering
  // regression into a refusal instead of a lost run -- resuming a run whose old process is still
  // alive puts two slaves on one branch, which is the failure this whole milestone is about.
  //
  // `isAlive` treats EPERM as alive (the process exists, it is just not ours to inspect) and only
  // ESRCH as gone, and returns `false` for a null pid -- which is NOT a refusal here: pre-M12 rows
  // carry no pid, and the pump clears nothing but records one only when it spawned.
  if (isAlive(run.pid)) {
    return err({ kind: 'run_still_stopping', runId: run.id })
  }

  // Conditioned on `paused` like every other claim in this package: between the read above and this
  // write the run may have been resumed by a tick, stopped, or concluded, and writing the intent
  // blindly would arm a resume against a run that is already running -- two slaves on one branch,
  // the failure the CLI's own claim comment spells out.
  //
  // `queuedMessage` is written only when a message came with the request. A resume asked for with
  // no message must not erase an instruction typed into the panel a moment earlier: the message is
  // a single overwritable slot, and `null` here means "say nothing", not "say nothing instead of
  // what was already queued".
  const claimed = await prisma.slaveRun.updateMany({
    where: { id: run.id, status: 'paused' },
    data: { resumeRequestedAt: new Date(), ...(message === null ? {} : { queuedMessage: message }) },
  })
  if (claimed.count === 0) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: RESUMABLE_STATUSES })
  }

  await appendEvent({
    type: 'run.resume_requested',
    workspaceId: run.slave.team.workspaceId,
    taskId: run.taskId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'human',
    payload: { requestedBy, message },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}

/**
 * Replaces the instruction waiting for this run, without asking for a resume.
 *
 * One slot, overwritten: the panel edits a draft, and an append-only pile of instructions would
 * hand the slave every abandoned draft on the way to the one the operator meant. Writable only
 * while `paused` for the same reason the intent is: a message queued against a run that is already
 * working would be consumed by whatever resumes it *next*, arriving in a context nobody wrote it
 * for.
 *
 * An empty or whitespace-only save clears the slot (stores `null`) rather than storing `''`: an
 * empty string must never be silently passed to the adapter as a literal resume prompt, and
 * clearing the textarea before saving is the natural "unqueue this instruction" gesture.
 */
export async function updateQueuedMessage(runId: string, rawMessage: string): Promise<Result<void, ControlRefusal>> {
  const message = rawMessage.trim() === '' ? null : rawMessage
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: { id: true, status: true } })
  if (run === null) return err({ kind: 'run_not_found', runId })

  const updated = await prisma.slaveRun.updateMany({
    where: { id: run.id, status: 'paused' },
    data: { queuedMessage: message },
  })
  if (updated.count === 0) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: RESUMABLE_STATUSES })
  }
  return ok(undefined)
}

/**
 * Daemon/CLI side: atomically claim `paused -> resuming`, clearing and returning the intent.
 *
 * The transition and the consumption of the message are one write, so the message is delivered
 * exactly once no matter how many ticks, daemons or CLI invocations look at the run at the same
 * moment: whoever's `updateMany` matched gets the row, everyone else gets `claimed: false` and
 * moves on. Conditioned on `resumeRequestedAt` as well as on the status, so a paused run nobody
 * asked to resume is never picked up by a pass that reads the status alone.
 *
 * The caller must be the process that then spawns the child. A claim without a spawn behind it is
 * a `resuming` row with no process, which is what the orphan sweep exists to fail.
 */
export async function claimResume(runId: string): Promise<{ claimed: boolean; queuedMessage: string | null }> {
  return prisma.$transaction(async (tx) => {
    // Read inside the transaction and before the update, because the update clears the column: this
    // is the only moment the message and the claim can be observed together.
    const run = await tx.slaveRun.findUnique({ where: { id: runId }, select: { queuedMessage: true } })
    const claimed = await tx.slaveRun.updateMany({
      where: { id: runId, status: 'paused', resumeRequestedAt: { not: null } },
      data: { status: 'resuming', resumeRequestedAt: null, queuedMessage: null },
    })
    return claimed.count === 1
      ? { claimed: true, queuedMessage: run?.queuedMessage ?? null }
      : { claimed: false, queuedMessage: null }
  })
}
