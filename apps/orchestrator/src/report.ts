import { isUniqueConstraintViolation, refusalText, reportQuestionKey, sendMessage } from '@slave-of-ai/control'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, parseSlaveReport } from '@slave-of-ai/domain'
import { joinRunOutput } from './runOutput.js'
import { rejectRunBack } from './runs.js'

/**
 * Reads a package worker's report (spec R7) before its work is verified. A well-formed report is
 * stored and its questions are sent to the conductor; a missing or malformed one fails the run and
 * sends the task back with the reason (`rejectRunBack`, shared with the ownership audit), so the
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
    await rejectRunBack(
      run,
      task,
      reason,
      `report: ${parsed.error}`,
      (attempt) => `no usable report after ${String(attempt)} attempts: ${parsed.error}`,
    )
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
