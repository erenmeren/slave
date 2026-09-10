import { createHash } from 'node:crypto'
import { sendMessage } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { parseSlaveAsk, type RunId, type SlaveAsk, type TaskId } from '@slave-of-ai/domain'
import type { appendEvent } from '@slave-of-ai/events'

/**
 * The free text written into `Checkpoint.pauseReason` for a run that stopped to ask (M36 t2).
 *
 * `Checkpoint.pauseReason` is the operator-facing sentence -- the string a gate deny put in front
 * of the slave -- while `SlaveRun.pauseReason` is the enum CATEGORY (`waiting_for_answer`). Two
 * columns, two vocabularies; see their doc comments in `schema.prisma`.
 */
export const ASK_PAUSE_REASON = 'waiting for another slave to answer a question'

/**
 * `SlaveRun.pauseReason`'s category for a run that asked -- the one thing that tells a waiting run
 * apart from a human pause, both of which are `paused`.
 *
 * Named here for the writer's sake; the readers use the enum member directly (`overview.ts`'s
 * "blocked · needs you" filter), because `apps/web` does not depend on this package and Prisma's
 * generated `PauseReason` type already refuses a typo at both ends.
 */
export const WAITING_FOR_ANSWER = 'waiting_for_answer'

/**
 * What {@link concludeWithQuestion} did.
 *
 * Only `waiting` changes anything the caller must react to: on every other outcome the run
 * concludes exactly as it would have if this function did not exist. `refused` carries a reason
 * because a slave that TRIED to ask and could not deserves a line in the daemon's log -- §13's "no
 * failure is silent" -- while `no_ask` is the ordinary shape of every run that never asked.
 */
export type AskConclusion =
  | { readonly kind: 'no_ask' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly messageId: string }

export interface AskConclusionInput {
  readonly runId: RunId
  /** `null` for a task-less `planning` run (M8b): the run still waits, there is just no task to park. */
  readonly taskId: TaskId | null
  /** The tail of the run's OWN output text, as the pump accumulated it -- see `ASK_TAIL_CAP`. */
  readonly text: string
  /** The run's tool-call count, recorded as `pausedAtStep` exactly as the two other pause routes do. */
  readonly toolCalls: number
  /**
   * Writes this run's `Checkpoint`, returning whether it could. Injected, because the spawn facts a
   * checkpoint needs (`settingsPath`, `hookPath`, the git identity, the model and provider the run
   * was started with) exist only inside the pump that started it -- `verifyConcludedRun` runs later
   * from database rows alone and cannot produce that row. This is why the ask is detected at the
   * run's conclusion INSIDE the pump rather than in `verify.ts`.
   */
  readonly writeCheckpoint: (pauseReason: string) => Promise<boolean>
  /** The pump's own event writer, so the pause is announced on the same run/task/slave scope. */
  readonly emit: (
    type: Parameters<typeof appendEvent>[0]['type'],
    actor: 'slave' | 'system',
    payload: unknown,
  ) => Promise<void>
}

/**
 * Whether an ask names somebody in this run's own workspace who could actually answer it.
 *
 * Server-side, and scoped, for the reason the milestone's constraint gives: the recipient is model
 * output. `sendMessage` already refuses a named slave outside the workspace (`cross_workspace`),
 * but it does NOT check that a role is held by anyone -- and parking a task to wait for a role
 * nobody holds is a task that waits forever. Both are treated as a malformed ask here, before
 * anything is written.
 *
 * The SENDER is excluded from both checks. `listMessagesForSlave` never hands a slave its own
 * send (M36 t1 fix round 1), so a slave that addresses itself -- directly, or by broadcasting to a
 * role it is the only holder of -- has addressed nobody, and would wait for an answer that cannot
 * arrive.
 */
async function recipientCanAnswer(
  ask: SlaveAsk,
  senderSlaveId: string,
  workspaceId: string,
): Promise<string | null> {
  if (ask.recipientSlaveId !== null) {
    if (ask.recipientSlaveId === senderSlaveId) return 'a slave cannot ask itself'
    const recipient = await prisma.slave.findUnique({
      where: { id: ask.recipientSlaveId },
      include: { team: true },
    })
    if (recipient === null) return `no slave with id ${ask.recipientSlaveId}`
    if (recipient.team.workspaceId !== workspaceId) return `slave ${ask.recipientSlaveId} is in another workspace`
    return null
  }

  const role = ask.recipientRole
  // Unreachable: `parseSlaveAsk` returns `malformed` unless exactly one recipient is set. Guarded
  // rather than asserted away so a future change to that parser fails here instead of counting
  // every slave in the workspace as a holder of the empty role.
  if (role === null) return 'the ask names no recipient'

  // A holder of a role is a slave that may be DISPATCHED as one (M37 §5): the roster this run was
  // shown lists `runtimeRoles`, so what it may address has to be counted the same way, or the ask
  // would be refused for a role the prompt itself offered.
  const holders = await prisma.slave.count({
    where: { runtimeRoles: { has: role }, id: { not: senderSlaveId }, team: { workspaceId } },
  })
  return holders > 0 ? null : `no other slave in this workspace holds the role "${role}"`
}

/** The message body: the question, with the asker's own context under it when it gave any. */
function bodyOf(ask: SlaveAsk): string {
  return ask.context === null ? ask.question : `${ask.question}\n\n${ask.context}`
}

/**
 * Concludes a run that ended by asking another slave a question (M36 t2).
 *
 * Called by `pumpRun` at the run's clean conclusion, INSTEAD of writing the terminal row -- the
 * whole point is that asking is not failing and not finishing: no attempt is charged
 * (`releaseTaskAfterFailure` is not on this path), no `run.failed` is written, and no verify or
 * review pass is consumed, because the run never becomes terminal at all.
 *
 * **The state it leaves behind, and why exactly this one.** The RUN parks in `paused` with a
 * `Checkpoint` and the `waiting_for_answer` category; the TASK parks in `waiting`, still pointing
 * at this run. `paused` is the one run status the orphan sweep leaves alone (`sweep.ts`'s
 * `ORPHANABLE`) and the one `requestResume`/`claimResume`/`executeResume` already act on, so Task
 * 3 delivers the answer and continues this very session with no new run-state machinery. Keeping
 * `Task.activeRunId` is the other half of that: a failure RELEASES the task (that is what charging
 * an attempt means), and this is not a failure -- the task is still this run's, and the run it
 * resumes into is the same one.
 *
 * **The order of writes.** Validate (reads only) -> checkpoint -> message -> claim the run ->
 * park the task. The checkpoint goes before anything is claimed for the same reason the gate pause
 * writes it before killing the child (M13 Decision 2): a paused run with no checkpoint can be
 * resumed by nobody, so a run that cannot be checkpointed must conclude the ordinary way instead.
 * The message goes before the claim because the two failures are not symmetrical: a question with
 * no waiting task is an unanswered message, while a waiting task with no question is a task that
 * waits forever for something nobody was ever asked. Two guards keep that ordering honest anyway:
 * the run's status is checked before anything is written, and the message carries an idempotency
 * key naming the run, the step and the question.
 */
export async function concludeWithQuestion(input: AskConclusionInput): Promise<AskConclusion> {
  const parsed = parseSlaveAsk(input.text)
  if (parsed.kind === 'absent') return { kind: 'no_ask' }
  if (parsed.kind === 'malformed') {
    // Loud, and then ordinary: a malformed block is not a rescue path (the milestone's constraint),
    // so the run concludes exactly as it would have -- but a slave that meant to ask and did not
    // must not vanish silently.
    console.warn(`[ask] run ${input.runId} ended with an unusable ask block: ${parsed.reason}`)
    return { kind: 'refused', reason: parsed.reason }
  }
  const { ask } = parsed

  // The sender comes from the RUN, never from the block -- the envelope has no sender field for a
  // model to lie in, exactly as `sendMessage` derives its own.
  const run = await prisma.slaveRun.findUnique({
    where: { id: input.runId },
    include: { slave: { include: { team: true } } },
  })
  if (run === null) return { kind: 'refused', reason: `run ${input.runId} no longer exists` }
  // Checked before anything is written, not just at the claim below: a run reaches its own clean
  // conclusion in `working` and in no other status (`session_started` writes it, for a fresh run
  // and a resumed one alike). Anything else means somebody else already owns this run's outcome --
  // an operator's stop, the sweep, or a conclusion being pumped a second time -- and sending the
  // question first and discovering that at the claim would leave a duplicate question behind. A
  // run an operator asked to pause (`pause_requested`) lands here too, and concludes the ordinary
  // way, exactly as it does today.
  if (run.status !== 'working') {
    return { kind: 'refused', reason: `the run is ${run.status}, not working: something else owns its outcome` }
  }
  // Only a run whose TASK this path can actually park may wait (final review, Important 1). The
  // park below is guarded on `activeRunId` AND on `status: 'running'`, and a `reviewing` task is
  // never `running` -- so parking a review run moved nothing: the task stayed `reviewing`,
  // `deliverAnswers` refused every answer to it (it demands a `waiting` task), and
  // `dispatchReview`'s "a review is already live" gate counted the paused run as live -- a review
  // run paused forever on a question nobody could ever answer, and a task no replacement review
  // would ever be dispatched for. (Until M41 Task 3b the status filter was belt to the
  // `activeRunId` braces, because `tick.ts`'s `startRun` was that column's only writer; a review
  // run holds its task's claim now, so the status filter is what carries this on its own.)
  //
  // A task-LESS run (`planning`, M8b) is parkable by definition: it has no task to park, the guard
  // below is skipped entirely, and delivery matches it through `slave -> team` rather than a task.
  // Everything else is refused the same way an unreachable recipient is -- loudly, and then the run
  // concludes exactly as it would have without this function.
  if (input.taskId !== null && run.kind !== 'implementation') {
    const reason = `a ${run.kind} run cannot wait for an answer: its task is not this run's to park`
    console.warn(`[ask] run ${input.runId} tried to ask a question it could never be answered on: ${reason}`)
    return { kind: 'refused', reason }
  }
  const senderSlaveId = run.slave.id
  const workspaceId = run.slave.team.workspaceId

  const unreachable = await recipientCanAnswer(ask, senderSlaveId, workspaceId)
  if (unreachable !== null) {
    console.warn(`[ask] run ${input.runId} asked somebody who cannot answer: ${unreachable}`)
    return { kind: 'refused', reason: unreachable }
  }

  if (!(await input.writeCheckpoint(ASK_PAUSE_REASON))) {
    // `writeCheckpoint` has already said why. Parking a run nothing can resume would strand the
    // task waiting on an answer that could never be delivered anywhere.
    return { kind: 'refused', reason: 'this run cannot be checkpointed, so it cannot be resumed' }
  }

  const body = bodyOf(ask)
  const sent = await sendMessage(input.runId, {
    kind: 'question',
    body,
    recipientSlaveId: ask.recipientSlaveId,
    recipientRole: ask.recipientRole,
    expectsReply: true,
    taskId: input.taskId,
    // Run, step and question together -- NOT the run id alone. One run asks more than once over
    // its life: Task 3 resumes this very session, and the continued run may reach another wall and
    // ask again. Keyed on the run alone, that second question would be swallowed as a replay of
    // the first, and the task would park `waiting` for a question nobody was ever asked. All three
    // parts are identical only when the SAME conclusion is written twice, which is the replay this
    // key is actually for.
    idempotencyKey: `ask:${input.runId}:${String(input.toolCalls)}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`,
  })
  if (!sent.ok) {
    // Unreachable after the validation above -- every refusal `sendMessage` can return for this
    // input (a malformed recipient, an unknown or cross-workspace one) has already been ruled out.
    // Reported rather than thrown: the run concludes the ordinary way, which is a worse outcome for
    // the slave than waiting but a safe one for the system.
    console.warn(`[ask] run ${input.runId} could not send its question: ${JSON.stringify(sent.error)}`)
    return { kind: 'refused', reason: `the question could not be sent: ${sent.error.kind}` }
  }

  // Claimed, not written: between the checkpoint above and here an operator's `cancel` or the sweep
  // may have concluded this run, and their decision stands. `status: 'working'` is the only state a
  // run reaches its own clean conclusion in (`session_started` writes it, for a fresh run and a
  // resumed one alike).
  const claimed = await prisma.slaveRun.updateMany({
    where: { id: input.runId, endedAt: null, status: 'working' },
    // `pid: null` (final review): the child has ALREADY exited -- this path runs at the run's own
    // clean conclusion, after the stream ended -- so the recorded pid names a process that is gone,
    // and pids are recycled. `requestResume` reads `isAlive(run.pid)` and refuses
    // `run_still_stopping` for a live one, which on a recycled pid would refuse to deliver the
    // answer to a run whose process died minutes ago. `executeResume` writes the new child's pid
    // back, so nothing downstream needs the stale one.
    data: { status: 'paused', pauseReason: WAITING_FOR_ANSWER, pausedAtStep: input.toolCalls, pid: null },
  })
  if (claimed.count === 0) {
    return { kind: 'refused', reason: 'the run was concluded by something else before it could wait' }
  }

  if (input.taskId !== null) {
    // Guarded on `activeRunId` and on `status: 'running'`, the same guard `releaseTaskAfterFailure`
    // uses plus the status: this parks the task only while it is still THIS run's AND actually
    // being implemented. A `reviewing` task whose review run asks a question is deliberately left
    // where it is -- it is `reviewing`, not `running`, so this write does not match it, and
    // `dispatchReview`'s "already live" gate counts this run as live for as long as it is
    // non-terminal, so the task is not re-dispatched while it waits.
    await prisma.task.updateMany({
      where: { id: input.taskId, activeRunId: input.runId, status: 'running' },
      data: { status: 'waiting' },
    })
  }

  // The same event the other two pause routes emit, with the same payload: the run IS paused, and
  // `SlaveRun.pauseReason` is where the difference between this and a human pause is recorded.
  await input.emit('run.paused', 'system', { atStep: input.toolCalls })
  return { kind: 'waiting', messageId: sent.value.id }
}
