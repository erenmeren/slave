import { announceQuestionClosed, closeQuestionIn, refusalText, requestResume, type CloseQuestionInput } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { CLOSED_BY_SYSTEM, DECIDED_WITHOUT_ANSWER, timeoutResumeMessage, type QuestionCloseReason } from '@slave-of-ai/domain'
import { WAITING_FOR_ANSWER } from './ask.js'

/** One waiting run this pass continued. */
export interface ContinuedRun {
  readonly runId: string
  readonly questionId: string
  readonly reason: QuestionCloseReason
}

/**
 * Human-cards spec H3 (plan A D7): one pass per tick, right after `deliverAnswers`. A run parked on a
 * question that nobody answered within the project's question timeout continues on its own
 * judgement: the run is resumed with the spec's sentence, and the question closes `timed_out`. A
 * question a person closed without an answer (Task 4's decided and dismissed closes) continues the
 * same way, at once, with its close note. An answered question is `deliverAnswers`' to deliver,
 * whatever its close says.
 *
 * **The resume first, the close after it.** The question closes `timed_out` only once this pass's
 * resume has taken effect, so a refused resume (a halt, a spent budget) never leaves a question
 * closed with its asker still parked on it. The run keeps waiting, the refusal is stored on the
 * question (`timeoutRefusal`) for the card to say why, and the next tick tries again. The cost of
 * the order is a crash window: a resume that committed with no close behind it leaves the question
 * open while its run continues, and the card's own expiry (Task 4, the asker no longer parked)
 * closes it later.
 *
 * **One resume between this pass and an answer.** Every resume here asks `onlyIfNotRequested`, as
 * `deliverAnswers` does, so the two claim the same `resumeRequestedAt IS NULL` slot and exactly one
 * wins. An answer seen before the claim leaves the run to `deliverAnswers`. An answer that commits
 * between the claim and the close finds the question still open and closes it `answered`; the
 * close below then writes nothing, the run continues on the timeout's sentence, and the answer,
 * left undelivered (its run is no longer waiting), is routed to the asking package as a late answer
 * (spec §4: "the other becomes a hand-off").
 */
export async function continueWaitingRuns(workspaceId: string, now: Date = new Date()): Promise<readonly ContinuedRun[]> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { questionTimeoutMs: true } })
  if (workspace === null) return []
  // `deliverAnswers`' own guards: still waiting, no intent standing, not stopped.
  const waiting = await prisma.slaveRun.findMany({
    where: { status: 'paused', pauseReason: WAITING_FOR_ANSWER, resumeRequestedAt: null, stopRequestedBy: null, slave: { team: { workspaceId } } },
    select: { id: true, taskId: true, pausedAt: true },
  })
  const continued: ContinuedRun[] = []
  for (const run of waiting) {
    const one = await continueOne(workspaceId, run, workspace.questionTimeoutMs, now)
    if (one !== null) continued.push(one)
  }
  return continued
}

/** Whether any live answer replies to the question. */
const answered = (questionId: string, client: Pick<Prisma.TransactionClient, 'slaveMessage'> = prisma): Promise<boolean> =>
  client.slaveMessage.count({ where: { replyToId: questionId, kind: 'answer', supersededAt: null } }).then((n) => n > 0)

async function continueOne(
  workspaceId: string,
  run: { readonly id: string; readonly taskId: string | null; readonly pausedAt: Date | null },
  timeoutMs: number,
  now: Date,
): Promise<ContinuedRun | null> {
  // `deliverToOneRun`'s match: a waiting run waits on the last question it sent.
  const question = await prisma.slaveMessage.findFirst({
    where: { senderRunId: run.id, kind: 'question', expectsReply: true },
    orderBy: { seq: 'desc' },
    select: { id: true, body: true, createdAt: true, taskId: true, slaveId: true, closedAt: true, closedReason: true, closedNote: true, timeoutRefusal: true },
  })
  if (question === null) return null
  // `deliverToOneRun`'s task guard: a task cancelled, superseded or handed on is not continued.
  if (run.taskId !== null) {
    const task = await prisma.task.findUnique({ where: { id: run.taskId }, select: { status: true, activeRunId: true } })
    if (task === null || task.status !== 'waiting' || task.activeRunId !== run.id) return null
  }
  if (question.closedReason === 'answered' || (await answered(question.id))) return null

  // An open question continues only past the timeout, and closes after the resume (see above). A
  // question already closed without an answer continues at once, with the note its close left.
  let reason: QuestionCloseReason
  let message: string
  let close: CloseQuestionInput | null = null
  if (question.closedAt === null) {
    const waitedMs = now.getTime() - (run.pausedAt ?? question.createdAt).getTime()
    if (waitedMs < timeoutMs) return null
    reason = 'timed_out'
    message = timeoutResumeMessage(waitedMs, question.body)
    close = { messageId: question.id, reason, by: CLOSED_BY_SYSTEM, note: message, decisionId: null }
  } else {
    if (question.closedReason === null) return null
    reason = question.closedReason
    message = question.closedNote ?? DECIDED_WITHOUT_ANSWER
  }

  const requested = await requestResume(
    run.id,
    message,
    reason === 'timed_out' ? 'the question timeout' : 'a decision on its question',
    undefined,
    'system',
    { onlyIfNotRequested: true },
  )
  if (!requested.ok) {
    // Lost to `deliverAnswers` (or anyone else's intent): the run is continuing, nothing to record.
    if (requested.error.kind === 'resume_already_requested') return null
    // A refusal is written before anything else is, so nothing is closed and the run keeps
    // waiting. Stored only when it changed, so a halt held for hours is one write, not one a tick.
    const why = refusalText(requested.error)
    if (question.timeoutRefusal !== why) {
      await prisma.slaveMessage.updateMany({ where: { id: question.id }, data: { timeoutRefusal: why } })
      console.warn(`[question-timeout] run ${run.id} waits on question ${question.id}: it cannot continue -- ${why}`)
    }
    return null
  }

  if (close === null) {
    if (question.timeoutRefusal !== null) await prisma.slaveMessage.updateMany({ where: { id: question.id }, data: { timeoutRefusal: null } })
    return { runId: run.id, questionId: question.id, reason }
  }

  // The resume took effect; now the close. Workspace row, then question row: the order
  // `answerQuestion` and the card verbs lock in, so an answer committing now is either already
  // closed here (and nothing is written) or waits until this close commits.
  const timedOut = close
  const closed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${question.id} FOR UPDATE`
    // Nothing written yet, so returning is safe: an answer that landed after the claim keeps its
    // `answered` close, and is routed as a late answer.
    if (await answered(question.id, tx)) return false
    return closeQuestionIn(tx, timedOut, now)
  })
  if (closed) {
    await announceQuestionClosed({ workspaceId, taskId: question.taskId, slaveId: question.slaveId }, timedOut, 'system', null)
  } else {
    console.warn(`[question-timeout] run ${run.id} continued past question ${question.id}, which was answered meanwhile: the answer goes to its package as a late answer`)
  }
  return { runId: run.id, questionId: question.id, reason }
}
