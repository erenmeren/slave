import { isUniqueConstraintViolation, refusalText, sendMessage } from '@slave-of-ai/control'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, parseSlaveReport, taskId as brandTaskId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { joinRunOutput } from './runOutput.js'
import { failConcludedRun } from './runs.js'
import { rejectTask } from './verify.js'

/**
 * Reads a package worker's report (spec R7) before its work is verified. A well-formed report is
 * stored and its questions are sent to the conductor; a missing or malformed one fails the run and
 * sends the task back with the reason -- through `rejectTask` and the `task.rework`/`task.failed`
 * events verify and review write, so the attempt counter bounds it like any rework. Returns whether verify may go on.
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
    const counted = await rejectTask(brandTaskId(task.id), reason)
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
      idempotencyKey: `report:${run.id}:${String(index)}`,
    })
    if (!sent.ok) {
      console.error(`[report] run ${run.id}: question ${String(index + 1)} was not sent -- ${refusalText(sent.error)}`)
    }
  }
  return true
}
