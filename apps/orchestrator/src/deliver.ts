import { requestResume } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { WAITING_FOR_ANSWER } from './ask.js'

const CLAIM_TIMEOUT_MS = 5_000
const CLAIM_MAX_WAIT_MS = 2_000

/** One waiting run woken by one answer. */
export interface AnswerDelivery {
  readonly runId: string
  readonly questionId: string
  readonly answerId: string
}

interface ClaimedAnswer {
  readonly id: string
  readonly body: string
  readonly slaveId: string
  readonly actor: string
}

/**
 * The instruction the resumed session opens with.
 *
 * The question is repeated alongside the answer because the resumed child is continued with
 * `--resume <sessionId>` and a single new user turn: the session still holds the conversation, but
 * an answer arriving with no question in front of it reads like a non-sequitur -- and a slave may
 * ask more than one thing over its life.
 */
function resumePrompt(question: string, answeredBy: string, answer: string): string {
  return `Your question has been answered.\n\nYou asked:\n${question}\n\n${answeredBy} answered:\n${answer}\n\nContinue your task with this answer.`
}

/**
 * Delivers answers to the runs waiting for them (M36 t3): one scheduling pass, called from `tick`.
 *
 * **How a question is matched to its waiting run.** From the RUN, not from the message: a run
 * `paused` with `pauseReason = waiting_for_answer` is waiting on the last `question` it sent
 * (`senderRunId`, highest `seq`), because that is the one the ask path parked it for. Working the
 * other way -- from an answer back to whatever run once asked something -- would resume a run on an
 * answer to a question it had already been answered on and asked past.
 *
 * **The guards, and what each of them is for.**
 * - `status: 'paused'` + `pauseReason: waiting_for_answer` -- the run is still waiting, and is not a
 *   human pause somebody else's Resume button owns. A stopped or terminal run is excluded by the
 *   status alone.
 * - `stopRequestedBy: null` -- an operator's stop stands even when the answer arrives afterwards.
 * - `resumeRequestedAt: null` -- an intent already stands (a web Resume, or an earlier pass); the
 *   tick's own claim pass owns it, and a second intent would say nothing new.
 * - the TASK is still `waiting` with `activeRunId` pointing at this run -- cancelled, superseded, or
 *   handed to another run, and the answer has arrived too late. (`SlaveRun.taskId` never moves, so
 *   "still the task the question was asked from" IS this pair.)
 *
 * **Why exactly one resume.** Two conditioned writes stand between an answer and a second child.
 * The first is {@link claimTheAnswer}: a transaction that locks the QUESTION row, refuses if any
 * answer to it has already been delivered, and stamps the one it picks -- so every pass looking at
 * one question is serialised, and one answer between them all is delivered. That covers a replay,
 * two ticks, a daemon racing a CLI, and two different answers arriving together. The second is
 * `claimResume`'s own `paused -> resuming` `updateMany` in the tick's resume pass, which is what
 * EVERY resume in the system goes through and what finally decides which caller spawns the child.
 *
 * An answer that loses that race keeps `deliveredAt` null and is never delivered: the run it would
 * have woken has already been woken, and it stops being scanned the moment that run is no longer
 * waiting. It stays in the thread, which is where an operator reads it.
 *
 * This pass never writes `Task.status`. `claimResume` flips `waiting -> running` atomically with the
 * run's own claim (M36 t2 fix round 1), and a second writer of that column here could start a task
 * whose run never spawned.
 */
export async function deliverAnswers(workspaceId: string): Promise<readonly AnswerDelivery[]> {
  const waiting = await prisma.slaveRun.findMany({
    // `slave -> team`, not `task`: a task-less `planning` run (M8b) can wait for an answer too.
    where: {
      status: 'paused',
      pauseReason: WAITING_FOR_ANSWER,
      resumeRequestedAt: null,
      stopRequestedBy: null,
      slave: { team: { workspaceId } },
    },
    select: { id: true, taskId: true },
  })

  const delivered: AnswerDelivery[] = []
  for (const run of waiting) {
    const one = await deliverToOneRun(run)
    if (one !== null) delivered.push(one)
  }
  return delivered
}

async function deliverToOneRun(run: {
  readonly id: string
  readonly taskId: string | null
}): Promise<AnswerDelivery | null> {
  const question = await prisma.slaveMessage.findFirst({
    where: { senderRunId: run.id, kind: 'question', expectsReply: true },
    orderBy: { seq: 'desc' },
    select: { id: true, body: true },
  })
  if (question === null) return null

  // Read before the claim, so a task that was cancelled, superseded or handed on costs nothing but
  // a read -- and, more importantly, so its answer is left UNCLAIMED. An answer stamped delivered
  // against a task nobody can resume is an answer nobody will ever try again.
  if (run.taskId !== null) {
    const task = await prisma.task.findUnique({
      where: { id: run.taskId },
      select: { status: true, activeRunId: true },
    })
    if (task === null || task.status !== 'waiting' || task.activeRunId !== run.id) return null
  }

  const answer = await claimTheAnswer(question.id)
  if (answer === null) return null

  const answeredBy = await describeAnswerer(answer)
  const requested = await requestResume(
    run.id,
    resumePrompt(question.body, answeredBy, answer.body),
    answeredBy,
    undefined,
    // An operator's answer IS a human intervention; another slave's answer is not one, and the
    // event log must not file it under a person who was never there.
    answer.actor === 'human' ? 'human' : 'system',
  )
  if (!requested.ok) {
    // Released, not left claimed: a halted workspace or a runtime that cannot resume is a state an
    // operator clears, and an answer stamped delivered by a refused resume would never be tried
    // again once they had.
    await prisma.slaveMessage.updateMany({ where: { id: answer.id }, data: { deliveredAt: null } })
    console.warn(`[deliver] run ${run.id} could not be resumed with answer ${answer.id}: ${requested.error.kind}`)
    return null
  }

  return { runId: run.id, questionId: question.id, answerId: answer.id }
}

/**
 * Claims one answer as THE answer that closes this question's wait, or `null` when there is none
 * left to claim.
 *
 * The `SELECT ... FOR UPDATE` on the question is the mutex -- the same idiom `sendMessage` uses on
 * the workspace row to serialise its own idempotency window. Every delivery pass looking at this
 * question queues behind it, and the one that arrives second sees the `deliveredAt` the first
 * committed and returns nothing. Without the lock, two passes reading before either writes would
 * each claim a DIFFERENT answer to the same question and each record a resume intent.
 *
 * Oldest first among the undelivered: whoever answered first closes the wait.
 */
async function claimTheAnswer(questionId: string): Promise<ClaimedAnswer | null> {
  return prisma.$transaction(
    async (tx): Promise<ClaimedAnswer | null> => {
      await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${questionId} FOR UPDATE`

      const alreadyDelivered = await tx.slaveMessage.count({
        where: { replyToId: questionId, deliveredAt: { not: null } },
      })
      if (alreadyDelivered > 0) return null

      const answer = await tx.slaveMessage.findFirst({
        where: { replyToId: questionId, kind: 'answer', deliveredAt: null },
        orderBy: { seq: 'asc' },
        select: { id: true, body: true, slaveId: true, actor: true },
      })
      if (answer === null) return null

      await tx.slaveMessage.update({ where: { id: answer.id }, data: { deliveredAt: new Date() } })
      return answer
    },
    { timeout: CLAIM_TIMEOUT_MS, maxWait: CLAIM_MAX_WAIT_MS },
  )
}

/**
 * Who the resumed slave is told answered it.
 *
 * `actor` decides, not the presence of a run: an operator's answer is attributed to the ASKER's own
 * slave row (`answerQuestion`'s doc comment explains why that column holds who a human ADDRESSED),
 * so reading the name off `slaveId` would tell the slave it had answered itself.
 */
async function describeAnswerer(answer: { readonly slaveId: string; readonly actor: string }): Promise<string> {
  if (answer.actor === 'human') return 'the operator'
  const slave = await prisma.slave.findUnique({ where: { id: answer.slaveId }, select: { name: true, role: true } })
  return slave === null ? 'another slave' : `${slave.name} (${slave.role})`
}
