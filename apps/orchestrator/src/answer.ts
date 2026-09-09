import { sendMessage } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { parseSlaveAnswers, type RunId, type SlaveAnswer, type TaskId } from '@slave-of-ai/domain'

/**
 * What {@link concludeWithAnswers} did.
 *
 * Nothing here changes the run's own outcome: answering somebody is an ordinary conclusion for the
 * ANSWERER -- its task proceeds exactly as it would have -- and the only state that moves is the
 * ASKER's, on the next delivery pass (`deliver.ts`). The counts are returned for the daemon's log,
 * because §13's "no failure is silent" applies to a slave that tried to answer and could not:
 * somebody is waiting on that answer.
 */
export interface AnswerConclusion {
  /** The `SlaveMessage` ids written, in the order the slave wrote the blocks. */
  readonly sent: readonly string[]
  /** One line per block that named nothing this slave could answer, or that was not an answer. */
  readonly refused: readonly string[]
}

export interface AnswerConclusionInput {
  readonly runId: RunId
  /** `null` for a task-less `planning` run (M8b): an answer is attached to the ANSWERER's task,
   *  which such a run does not have -- the message is still written. */
  readonly taskId: TaskId | null
  /** The tail of the run's OWN output text, as the pump accumulated it -- see `ASK_TAIL_CAP`. */
  readonly text: string
}

const EMPTY: AnswerConclusion = { sent: [], refused: [] }

/**
 * Whether this run's slave may answer `messageId` -- the refusal, or the question row it named.
 *
 * Server-side and workspace-scoped for the milestone's reason: the id is model output. A question
 * in another workspace reads back exactly like one that never existed (the same boundary
 * `sendMessage` and `markMessageRead` already enforce in both directions), and a question
 * addressed to somebody else is refused even inside the workspace -- otherwise any slave could
 * close any other slave's wait with an answer nobody asked it for.
 */
async function questionThisSlaveMayAnswer(
  messageId: string,
  slave: { readonly id: string; readonly runtimeRoles: readonly string[] },
  workspaceId: string,
): Promise<{ readonly refusal: string } | { readonly question: { id: string; slaveId: string; taskId: string | null } }> {
  const message = await prisma.slaveMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: { id: true, slaveId: true, taskId: true, kind: true, recipientSlaveId: true, recipientRole: true },
  })
  if (message === null) return { refusal: `no question with id ${messageId} in this workspace` }
  if (message.kind !== 'question') return { refusal: `message ${messageId} is a ${message.kind}, not a question` }
  // A slave that answers its own question would deliver an answer to itself and resume its own
  // wait on nothing -- and `listMessagesForSlave` never showed it that question in the first place.
  if (message.slaveId === slave.id) return { refusal: `message ${messageId} is this slave's own question` }

  const addressedDirectly = message.recipientSlaveId === slave.id
  // `runtimeRoles`, not `role` (M37 §5): the question reached this run's prompt through
  // `listMessagesForSlave`, which matches the same set -- the two must agree, or a slave would be
  // shown a question it is then refused permission to answer.
  const addressedByRole = message.recipientRole !== null && slave.runtimeRoles.includes(message.recipientRole)
  if (!addressedDirectly && !addressedByRole) {
    return { refusal: `question ${messageId} is not addressed to this slave` }
  }
  return { question: { id: message.id, slaveId: message.slaveId, taskId: message.taskId } }
}

/**
 * Writes the answers a run gave to the questions its own prompt carried (M36 t3).
 *
 * Called by `pumpRun` at a clean conclusion, BEFORE the ask hook (`ask.ts`) and without touching
 * the run's outcome: a slave that answers somebody and then asks a question of its own does both,
 * in that order, and a slave that only answers concludes exactly as it would have.
 *
 * The blocks come through `parseSlaveAnswers`'s zod boundary and nothing else: the milestone's
 * constraint is that free-form model output never mutates state, and the only fields that survive
 * that boundary are a message id and a body. WHO sent the answer is taken from the run
 * (`sendMessage` derives it), and WHO receives it is taken from the question row -- neither is
 * anything the model can name.
 *
 * The idempotency key is `answer:<run>:<question>`: a run answers a given question once, and a
 * conclusion pumped twice writes one row. The run's own status guard below normally refuses the
 * replay first -- the key is what holds when it cannot.
 */
export async function concludeWithAnswers(input: AnswerConclusionInput): Promise<AnswerConclusion> {
  const parsed = parseSlaveAnswers(input.text)
  if (parsed.answers.length === 0 && parsed.malformed.length === 0) return EMPTY
  for (const reason of parsed.malformed) {
    // Loud, and then ordinary: a malformed block is not a rescue path, but a slave that meant to
    // answer and did not leaves somebody waiting, and that must not be silent.
    console.warn(`[answer] run ${input.runId} wrote an unusable answer block: ${reason}`)
  }
  if (parsed.answers.length === 0) return { sent: [], refused: [...parsed.malformed] }

  const run = await prisma.slaveRun.findUnique({
    where: { id: input.runId },
    include: { slave: { include: { team: true } } },
  })
  if (run === null) return { sent: [], refused: [`run ${input.runId} no longer exists`] }
  // The same guard the ask path applies, for the same reason: `working` is the only status a run
  // reaches its own clean conclusion in, and anything else means somebody else owns this run's
  // outcome -- an operator's stop, the sweep, or a conclusion being pumped a second time.
  if (run.status !== 'working') {
    return { sent: [], refused: [`the run is ${run.status}, not working: something else owns its outcome`] }
  }

  const sent: string[] = []
  const refused: string[] = [...parsed.malformed]
  for (const answer of parsed.answers) {
    const outcome = await writeOneAnswer(input, answer, run.slave, run.slave.team.workspaceId)
    if (outcome.written) sent.push(outcome.messageId)
    else {
      console.warn(`[answer] run ${input.runId} could not answer ${answer.messageId}: ${outcome.reason}`)
      refused.push(outcome.reason)
    }
  }
  return { sent, refused }
}

type OneAnswer = { readonly written: true; readonly messageId: string } | { readonly written: false; readonly reason: string }

/** One block, checked against the database and (if it survives) written. */
async function writeOneAnswer(
  input: AnswerConclusionInput,
  answer: SlaveAnswer,
  slave: { readonly id: string; readonly runtimeRoles: readonly string[] },
  workspaceId: string,
): Promise<OneAnswer> {
  const checked = await questionThisSlaveMayAnswer(answer.messageId, slave, workspaceId)
  if ('refusal' in checked) return { written: false, reason: checked.refusal }

  const written = await sendMessage(input.runId, {
    kind: 'answer',
    body: answer.answer,
    // The ASKER, read off the question row rather than off the block: the reply goes back to
    // whoever asked, and a model naming a different recipient would be answering a question in
    // somebody else's name.
    recipientSlaveId: checked.question.slaveId,
    replyToId: checked.question.id,
    // The ANSWERER's own task, not the asker's: this is a fact produced by this run.
    taskId: input.taskId,
    idempotencyKey: `answer:${input.runId}:${checked.question.id}`,
  })
  if (!written.ok) return { written: false, reason: `the answer could not be sent: ${written.error.kind}` }
  return { written: true, messageId: written.value.id }
}
