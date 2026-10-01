import { isTransactionTimeout, isUniqueConstraintViolation, refusalText, reportQuestionKey, routeHandOffs, sendMessage, type RouteHandOffsInput } from '@slave-of-ai/control'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, parseSlaveReport } from '@slave-of-ai/domain'
import { joinRunOutput } from './runOutput.js'
import { rejectRunBack } from './runs.js'
import { handOffSmokeRework } from './smoke.js'

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
  // Plan B D11 (user ruling 2026-09-30): a smoke rework's hand-off, checked against package
  // ownership inside -- a claim that does not hold changes nothing, and never fails this run.
  if (parsed.value.handOff !== undefined) await handOffSmokeRework(run, task, parsed.value.handOff)
  // Supervisor-as-conductor spec C2 (plan A D1-D8): each hand-off to the package that owns it, by the
  // ownership rule. Idempotent per run and position, like the questions above, so a replayed
  // conclusion routes nothing twice. An old-shape report carries none and routes nothing.
  if (parsed.value.handOffs.length > 0) {
    await routeThroughBusyLock({
      workspaceId: task.workspaceId,
      goalVersion: pkg.goalVersion,
      source: 'report',
      sourceKey: `report:${run.id}`,
      fromRunId: run.id,
      fromPackageKey: pkg.key,
      items: parsed.value.handOffs,
    })
  }
  return true
}

/** How many times filing tries a routing that a busy lock or a starved pool refused (P2028). */
const HAND_OFF_ROUTE_ATTEMPTS = 3

/**
 * Task 6: `routeHandOffs` takes the version's delivery lock, and a waiter fails with P2028 when the
 * lock or a pooled connection is not had in time. That is contention, not a verdict on the run, so
 * filing tries again -- safe because routing is idempotent per `<sourceKey>:<i>` and a replay
 * announces what an interrupted pass stored. A lock still busy after the last try never fails the
 * filing (Task 6 ruling, review I1): the report is stored, so the goal pass's `routeStoredHandOffs`
 * routes it, and the run's finished work goes on to verify. Any other error propagates.
 */
async function routeThroughBusyLock(input: RouteHandOffsInput): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await routeHandOffs(input)
      return
    } catch (error) {
      if (!isTransactionTimeout(error)) throw error
      if (attempt >= HAND_OFF_ROUTE_ATTEMPTS) {
        console.error(`[report] run ${input.fromRunId}: its hand-offs wait for the next goal pass -- the lock stayed busy through ${String(HAND_OFF_ROUTE_ATTEMPTS)} tries`)
        return
      }
      console.error(`[report] run ${input.fromRunId}: routing its hand-offs waited on a busy lock -- trying again (${String(attempt)}/${String(HAND_OFF_ROUTE_ATTEMPTS)})`)
    }
  }
}
