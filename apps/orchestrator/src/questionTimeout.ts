import { announceQuestionClosed, closeQuestion, closeQuestionIn, refusalText, requestResume, workspaceResumeRefusal, type CloseQuestionInput, type ControlRefusal } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { CARD_EXPIRED_NOTE, CLOSED_BY_SYSTEM, DECIDED_WITHOUT_ANSWER, timeoutResumeMessage, type QuestionCloseReason } from '@slave-of-ai/domain'
import { WAITING_FOR_ANSWER } from './ask.js'

const CLOSE_TIMEOUT_MS = 15_000
const CLOSE_MAX_WAIT_MS = 2_000

/**
 * The resume path, reachable for a test: one assignable slot rather than a module mock, so a test
 * can act inside the locked window (assign a wrapper, restore it in `finally`).
 */
export const questionTimeoutDeps: { requestResume: typeof requestResume } = { requestResume }

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
 * **One transaction: lock, re-check, resume, close.** For an open question past the timeout the
 * pass locks the Workspace row and then the question row (the order `answerQuestion` and the card
 * verbs lock in), re-checks that the question is still open and unanswered, asks for the resume
 * while holding both locks, and closes the question `timed_out` in the same transaction only when
 * the resume took effect. So:
 * - a refused resume (a halt, a spent budget) writes nothing in the transaction: the question stays
 *   open, the run keeps waiting, the refusal is stored on the question (`timeoutRefusal`) for the
 *   card to say why, and the next tick tries again;
 * - an answer committed before the locks is seen by the re-check, and the run is left to
 *   `deliverAnswers`;
 * - an answer arriving while the pass holds the locks waits on the Workspace row, and lands after
 *   the commit as a late answer on a `timed_out` question, which the goal pass routes to the asking
 *   package (`routeLateAnswers`; spec §4: "the other becomes a hand-off").
 *
 * `requestResume` runs on its own connection inside that window. It takes no row lock the pass
 * holds -- its reads are plain, its claim updates the `SlaveRun` row, and `ExecutionEvent` has no
 * foreign key to `Workspace` -- so it cannot wait on the pass. Its writes commit on their own: a
 * crash, a throw or a timeout between them and the close leaves the question open while its run
 * continues, and {@link closeResumedQuestions} closes it on a later pass (final wave, finding 5).
 *
 * **One resume between this pass and an answer.** Every resume here asks `onlyIfNotRequested`, as
 * `deliverAnswers` does, so the two claim the same `resumeRequestedAt IS NULL` slot and exactly one
 * wins; the loser writes nothing (`deliverAnswers` releases its answer).
 */
export async function continueWaitingRuns(workspaceId: string, now: Date = new Date()): Promise<readonly ContinuedRun[]> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { questionTimeoutMs: true } })
  if (workspace === null) return []
  // Final wave, finding 5: first the questions whose run continued without this pass closing them.
  try {
    await closeResumedQuestions(workspaceId, now)
  } catch (error) {
    console.error(`[question-timeout] workspace ${workspaceId}: resumed runs' open questions were not closed this pass:`, error)
  }
  // `deliverAnswers`' own guards: still waiting, no intent standing, not stopped.
  const waiting = await prisma.slaveRun.findMany({
    where: { status: 'paused', pauseReason: WAITING_FOR_ANSWER, resumeRequestedAt: null, stopRequestedBy: null, slave: { team: { workspaceId } } },
    select: { id: true, taskId: true, pausedAt: true },
  })
  if (waiting.length === 0) return []
  // Final wave, finding 4: a halt or a spent budget refuses every resume of the pass. Read once,
  // outside every lock, rather than by `requestResume` under the locks once per run; a refused pass
  // records why on each question it would have continued, and resumes nothing.
  const refused = await workspaceResumeRefusal(workspaceId)
  const continued: ContinuedRun[] = []
  for (const run of waiting) {
    // One run that throws (a lock timeout, a vanished row) is said and skipped; the rest go on, and
    // the next tick tries it again.
    try {
      const one = await continueOne(workspaceId, run, workspace.questionTimeoutMs, now, refused)
      if (one !== null) continued.push(one)
    } catch (error) {
      console.error(`[question-timeout] run ${run.id} was not continued this pass:`, error)
    }
  }
  return continued
}

/** What a question closed by {@link closeResumedQuestions} says its run was given. */
export const RESUMED_WITHOUT_ANSWER_NOTE = 'The run was resumed without an answer to this question.'

/**
 * Final wave, finding 5: the backstop for a resume that stood while its question stayed open. The
 * pass's resume commits on its own connection (`requestResume` writes through the global client), so
 * a transaction that rolls back after it -- a throw, a timeout -- leaves the run continuing and the
 * question open; a person's Resume on a parked run does the same. Any open question whose asking run
 * is no longer parked, that a `run.resume_requested` event of that run follows, and that has no
 * answer is closed here `timed_out` by the system: its run did continue without an answer. Its card
 * stays open (spec H3). One query; each close takes the question lock and is conditional.
 */
export async function closeResumedQuestions(workspaceId: string, now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m.id
    FROM "SlaveMessage" m
    JOIN "SlaveRun" r ON r.id = m."senderRunId"
    WHERE m."workspaceId" = ${workspaceId}
      AND m.kind = 'question'
      AND m."expectsReply" = true
      AND m."closedAt" IS NULL
      AND NOT (r.status = 'paused' AND r."pauseReason" = 'waiting_for_answer')
      AND NOT EXISTS (SELECT 1 FROM "SlaveMessage" a WHERE a."replyToId" = m.id AND a.kind = 'answer')
      AND EXISTS (SELECT 1 FROM "ExecutionEvent" e WHERE e."runId" = r.id AND e.type = 'run.resume_requested' AND e.ts > m."createdAt")
    ORDER BY m.seq`
  let closed = 0
  for (const row of rows) {
    const did = await closeQuestion({ messageId: row.id, reason: 'timed_out', by: CLOSED_BY_SYSTEM, decisionId: null, note: () => RESUMED_WITHOUT_ANSWER_NOTE }, 'system', null, now)
    if (did) closed += 1
  }
  return closed
}

/** Whether any live answer replies to the question. */
const answered = (questionId: string, client: Pick<Prisma.TransactionClient, 'slaveMessage'> = prisma): Promise<boolean> =>
  client.slaveMessage.count({ where: { replyToId: questionId, kind: 'answer', supersededAt: null } }).then((n) => n > 0)

async function continueOne(
  workspaceId: string,
  run: { readonly id: string; readonly taskId: string | null; readonly pausedAt: Date | null },
  timeoutMs: number,
  now: Date,
  refused: ControlRefusal | null,
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

  // A question already closed without an answer continues at once, with the note its close left;
  // nothing is closed, so its resume needs no lock.
  if (question.closedAt !== null) {
    if (question.closedReason === null) return null
    if (refused !== null) return recordRefusal(run.id, question, refused)
    const reason = question.closedReason
    // A card's expiry leaves a marker, not a turn (finding 7): such a run is told what a timeout says.
    const note =
      question.closedNote === CARD_EXPIRED_NOTE
        ? timeoutResumeMessage(now.getTime() - (run.pausedAt ?? question.createdAt).getTime(), question.body)
        : (question.closedNote ?? DECIDED_WITHOUT_ANSWER)
    const requested = await questionTimeoutDeps.requestResume(
      run.id,
      note,
      reason === 'timed_out' ? 'the question timeout' : 'a decision on its question',
      undefined,
      'system',
      { onlyIfNotRequested: true, budgetChecked: true },
    )
    if (!requested.ok) return recordRefusal(run.id, question, requested.error)
    if (question.timeoutRefusal !== null) await prisma.slaveMessage.updateMany({ where: { id: question.id }, data: { timeoutRefusal: null } })
    return { runId: run.id, questionId: question.id, reason }
  }

  // An open question continues only past the timeout.
  const waitedMs = now.getTime() - (run.pausedAt ?? question.createdAt).getTime()
  if (waitedMs < timeoutMs) return null
  if (refused !== null) return recordRefusal(run.id, question, refused)
  const message = timeoutResumeMessage(waitedMs, question.body)
  const close: CloseQuestionInput = { messageId: question.id, reason: 'timed_out', by: CLOSED_BY_SYSTEM, note: message, decisionId: null }
  const outcome = await prisma.$transaction(
    async (tx): Promise<{ readonly kind: 'skipped' } | { readonly kind: 'refused'; readonly error: ControlRefusal } | { readonly kind: 'continued'; readonly closed: boolean }> => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${question.id} FOR UPDATE`
      // Every return before `closeQuestionIn` precedes the transaction's only write, so returning
      // (not throwing) commits nothing. Closed meanwhile (an answer, a card): the next tick reads it.
      const state = await tx.slaveMessage.findUniqueOrThrow({ where: { id: question.id }, select: { closedAt: true } })
      if (state.closedAt !== null || (await answered(question.id, tx))) return { kind: 'skipped' }
      const requested = await questionTimeoutDeps.requestResume(run.id, message, 'the question timeout', undefined, 'system', { onlyIfNotRequested: true, budgetChecked: true })
      if (!requested.ok) return { kind: 'refused', error: requested.error }
      return { kind: 'continued', closed: await closeQuestionIn(tx, close, now) }
    },
    // `requestResume` runs inside the window (the budget was read once, before it), and a busy
    // database can still outlast Prisma's 5 s.
    { timeout: CLOSE_TIMEOUT_MS, maxWait: CLOSE_MAX_WAIT_MS },
  )
  if (outcome.kind === 'skipped') return null
  if (outcome.kind === 'refused') return recordRefusal(run.id, question, outcome.error)
  if (outcome.closed) await announceQuestionClosed({ workspaceId, taskId: question.taskId, slaveId: question.slaveId }, close, 'system', null)
  return { runId: run.id, questionId: question.id, reason: 'timed_out' }
}

/**
 * A refused resume: the run keeps waiting. Lost to another intent (`deliverAnswers`, a person's
 * Resume), it is continuing and nothing is recorded; otherwise the reason is stored on the question
 * for its card, only when it changed, so a halt held for hours is one write, not one a tick.
 */
async function recordRefusal(runId: string, question: { readonly id: string; readonly timeoutRefusal: string | null }, error: ControlRefusal): Promise<null> {
  if (error.kind === 'resume_already_requested') return null
  const why = refusalText(error)
  if (question.timeoutRefusal !== why) {
    await prisma.slaveMessage.updateMany({ where: { id: question.id }, data: { timeoutRefusal: why } })
    console.warn(`[question-timeout] run ${runId} waits on question ${question.id}: it cannot continue -- ${why}`)
  }
  return null
}
