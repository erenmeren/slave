import { listMessagesForSlave } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { ANSWER_BLOCK_CLOSE, ANSWER_BLOCK_OPEN } from '@slave-of-ai/domain'

/**
 * What a run's prompt carried from this slave's inbox, and which rows it was.
 *
 * `section` is `null`, not `''`, when there is nothing pending: the caller has to be able to tell
 * "no messages" from "a section that happens to be empty", and nearly every run is the first.
 */
export interface PendingInbox {
  readonly section: string | null
  /** Recorded on the run (`SlaveRun.suppliedMessageIds`) so a debugger can reconstruct its inputs. */
  readonly messageIds: readonly string[]
}

const NOTHING: PendingInbox = { section: null, messageIds: [] }

/**
 * The unanswered questions addressed to one slave, rendered for the top of its next run's prompt
 * (M36 t3).
 *
 * **Deliberately minimal.** Only messages addressed to THIS slave (directly or by a role it holds),
 * only ones still expecting a reply, and nothing else about the world -- the milestone's plan puts
 * the full run-context builder in a later milestone, and the failure mode of getting ahead of it is
 * a prompt nobody can read. `listMessagesForSlave`'s `unansweredOnly` filter is exactly this set,
 * scoped to the slave's own workspace, and it never returns a slave its own sends.
 *
 * Nothing here marks anything read: a run that fails to spawn would otherwise consume the messages
 * it never showed anybody. `SlaveRun.suppliedMessageIds` is the durable record of what was actually
 * put in front of the slave, written once the child is up.
 */
export async function pendingInbox(slaveId: string): Promise<PendingInbox> {
  const pending = await listMessagesForSlave(slaveId, { unansweredOnly: true })
  if (!pending.ok) {
    // The only refusal this call can return is `slave_not_found`, for a slave the dispatch just
    // read. Reported rather than thrown: an unreadable inbox must not stop a run from starting.
    console.warn(`[inbox] could not read the inbox of slave ${slaveId}: ${pending.error.kind}`)
    return NOTHING
  }
  if (pending.value.length === 0) return NOTHING

  const senders = await prisma.slave.findMany({
    where: { id: { in: [...new Set(pending.value.map((message) => message.senderSlaveId))] } },
    select: { id: true, name: true, role: true },
  })
  const nameById = new Map(senders.map((slave) => [slave.id, `${slave.name} (${slave.role})`]))

  const items = pending.value.map((message) => {
    const from = nameById.get(message.senderSlaveId) ?? message.senderSlaveId
    return `- from ${from}, message id ${message.id}:\n  ${message.body.replaceAll('\n', '\n  ')}`
  })

  // The envelope is spelled out with a real message id from the list above, so the slave copies
  // rather than invents one. `apps/orchestrator/src/answer.ts` refuses an id it cannot match to a
  // question addressed to this slave, so an invented one costs the answer, not the run.
  const example = `${ANSWER_BLOCK_OPEN}{"messageId":"${pending.value[0]?.id ?? ''}","answer":"..."}${ANSWER_BLOCK_CLOSE}`
  const section = [
    'MESSAGES ADDRESSED TO YOU',
    '',
    'Another slave asked you these and cannot continue until you reply.',
    '',
    ...items,
    '',
    'Answer what you can. To answer, put one block like this in your FINAL message, one per question:',
    example,
    '',
    'Answering does not end your own task, which follows.',
    '',
    '---',
  ].join('\n')

  return { section, messageIds: pending.value.map((message) => message.id) }
}

/** The prompt a run actually starts from: its inbox, then its task. */
export function withInbox(section: string | null, prompt: string): string {
  return section === null ? prompt : `${section}\n\n${prompt}`
}
