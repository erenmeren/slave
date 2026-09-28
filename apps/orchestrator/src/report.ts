import { isUniqueConstraintViolation, refusalText, reportQuestionKey, sendMessage } from '@slave-of-ai/control'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, parseSlaveReport } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { joinRunOutput } from './runOutput.js'
import { failConcludedRun } from './runs.js'

/**
 * Reads a package worker's report (spec R7) before its work is verified. A well-formed report is
 * stored and its questions are sent to the conductor; a missing or malformed one fails the run and
 * sends the task back with the reason -- `rejectTask`'s rework-or-fail, guarded on the run still
 * holding the task, and the `task.rework`/`task.failed` events verify and review write, so the
 * attempt counter bounds it like any rework. Returns whether verify may go on.
 *
 * Replayable, like `verifyConcludedRun` that calls it: the same run concluded twice finds its
 * report already stored (the `runId` unique index answers P2002) and treats it as filed, and each
 * question carries an idempotency key per run and position, so a replay that completes an
 * interrupted first pass sends only what that pass did not.
 */
export async function fileRunReport(
  run: { readonly id: string; readonly slaveId: string },
  task: { readonly id: string; readonly workspaceId: string; readonly workPackageId: string },
): Promise<boolean> {
  const rows = await prisma.executionEvent.findMany({
    where: { runId: run.id, type: 'run_output' },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  })
  const text = joinRunOutput(rows.map((row) => row.payload))
  const pkg = await prisma.workPackage.findUniqueOrThrow({ where: { id: task.workPackageId } })
  const parsed = parseSlaveReport(text, pkg.requirementKeys)
  if (!parsed.ok) {
    const reason = `Your final message did not carry a usable report -- ${parsed.error}. Finish with the <slave-report> block your instructions describe.`
    // The task first: a crash before the run is failed still leaves the reason on the task.
    const counted = await rejectOwnedTask(task.id, run.id, reason)
    // `null`: the task is no longer this run's (final review I3) -- a replay of a conclusion this
    // already rejected, or a late result for a task a person cancelled. Charging it again would
    // spend a second attempt or revive the task, so only the run is failed.
    if (counted !== null) {
      // The same events verify's and review's rejections write, so the board and the Supervisor see
      // a missing report like any other rework -- and, at the cap, the task's own terminal (§13).
      await appendEvent(
        counted.exhausted
          ? {
              type: 'task.failed',
              workspaceId: task.workspaceId,
              taskId: task.id,
              actor: 'system',
              payload: { reason: `no usable report after ${String(counted.attempt)} attempts: ${parsed.error}` },
            }
          : {
              type: 'task.rework',
              workspaceId: task.workspaceId,
              taskId: task.id,
              actor: 'system',
              payload: { reason, attempt: counted.attempt },
            },
      )
    }
    await failConcludedRun(run, task.workspaceId, `report: ${parsed.error}`)
    return false
  }
  try {
    await prisma.runReport.create({
      data: {
        runId: run.id,
        taskId: task.id,
        workPackageId: pkg.id,
        report: parsed.value as unknown as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error
  }
  for (const [index, question] of parsed.value.questions.entries()) {
    const sent = await sendMessage(run.id, {
      kind: 'question',
      body: question,
      recipientRole: CONDUCTOR_ROLE,
      expectsReply: true,
      taskId: task.id,
      // The key is also what keeps the question pending with nobody parked on it (`stillPendingQuestion`).
      idempotencyKey: reportQuestionKey(run.id, index),
    })
    if (!sent.ok) {
      console.error(`[report] run ${run.id}: question ${String(index + 1)} was not sent -- ${refusalText(sent.error)}`)
    }
  }
  return true
}

/**
 * `rejectTask`'s rework-or-fail, but only while `run` still holds the task (`activeRunId`), the
 * guard `releaseTaskAfterFailure` puts on every release. Both writes are conditioned on it inside
 * one transaction, so a replay or a cancel that won the race matches nothing and charges nothing.
 * `null` when the task was not this run's to reject.
 */
async function rejectOwnedTask(
  taskId: string,
  runId: string,
  reason: string,
): Promise<{ readonly attempt: number; readonly exhausted: boolean } | null> {
  return prisma.$transaction(async (tx) => {
    const charged = await tx.task.updateMany({
      where: { id: taskId, activeRunId: runId },
      data: { attempt: { increment: 1 } },
    })
    if (charged.count === 0) return null
    const after = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { attempt: true, maxAttempts: true } })
    const exhausted = after.attempt >= after.maxAttempts
    await tx.task.updateMany({
      where: { id: taskId, activeRunId: runId },
      // `lastRejectionReason` is the slave-facing channel: the next run's `rejection` section.
      data: { status: exhausted ? 'failed' : 'rework', activeRunId: null, lastRejectionReason: reason },
    })
    return { attempt: after.attempt, exhausted }
  })
}
