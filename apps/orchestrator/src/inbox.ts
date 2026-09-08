import { listMessagesForSlave } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { ANSWER_BLOCK_CLOSE, ANSWER_BLOCK_OPEN, ASK_BLOCK_CLOSE, ASK_BLOCK_OPEN } from '@slave-of-ai/domain'

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

/**
 * How many peers the roster below names before it stops (final review, Important 2).
 *
 * The roster is there so a slave addresses somebody who exists rather than inventing a role; it is
 * not a directory. A large project would otherwise spend hundreds of prompt lines on names nobody
 * reads, and `recipientCanAnswer` (`ask.ts`) still validates whatever the slave writes -- the
 * roster is a hint, and a truncated hint is still a hint.
 */
const ROSTER_CAP = 25

/**
 * The few lines that teach an implementation run HOW to ask, and who it may ask (final review,
 * Important 2).
 *
 * Nothing taught a slave the `<slave-ask>` envelope before this: the whole waiting loop existed and
 * could not fire in production, because a model has no way to guess a tag it has never been shown.
 * The markers come from `packages/domain/src/messaging/ask.ts` rather than being written out here,
 * so the string the parser looks for and the string the prompt teaches cannot drift apart.
 *
 * **IMPLEMENTATION runs only.** `apps/orchestrator/src/ask.ts` refuses an ask from a `review` run
 * (its task is not that run's to park), so teaching a reviewer the envelope would teach it a move
 * that always ends in an ordinary conclusion and a warning line. `review.ts`'s `buildReviewPrompt`
 * and `planning.ts`'s `buildPlanningPrompt` are therefore left alone; only `tick.ts`'s dispatch
 * composes this in.
 *
 * `null` when this slave has no peers: with nobody else in the workspace, every recipient the slave
 * could name is refused by `recipientCanAnswer` anyway, and an offer the system will always turn
 * down is worse than no offer.
 */
export async function askProtocol(slaveId: string, workspaceId: string): Promise<string | null> {
  const peers = await prisma.slave.findMany({
    where: { id: { not: slaveId }, team: { workspaceId } },
    select: { id: true, name: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    take: ROSTER_CAP,
  })
  if (peers.length === 0) return null

  const roster = peers.map((peer) => `- ${peer.name}, role "${peer.role}", id ${peer.id}`)
  return [
    'ASKING ANOTHER SLAVE',
    '',
    'If you cannot continue without an answer somebody else has to give, do not guess. End your',
    'FINAL message with one block like this and stop there:',
    `${ASK_BLOCK_OPEN}{"role":"<a role below>","question":"..."}${ASK_BLOCK_CLOSE}`,
    `Use "slaveId":"<an id below>" instead of "role" to ask one slave by name. Add "context":"..."`,
    'for anything the answerer needs to know first.',
    '',
    'Your run stops there. That is not a failure: it costs you no attempt, and you are resumed in',
    'this same session, in this same worktree, with the answer in front of you. Ask only when you',
    'are genuinely stuck; finish the task otherwise.',
    '',
    'Slaves you can address:',
    ...roster,
    '',
    '---',
  ].join('\n')
}

/** The prompt a run actually starts from: the sections above (its inbox, the ask protocol), then
 *  its task. Absent sections are skipped rather than rendered empty. */
export function withPreamble(sections: readonly (string | null)[], prompt: string): string {
  const present = sections.filter((section): section is string => section !== null)
  return present.length === 0 ? prompt : `${present.join('\n\n')}\n\n${prompt}`
}
