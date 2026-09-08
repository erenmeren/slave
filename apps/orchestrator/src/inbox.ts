import { listMessagesForSlave } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  ANSWER_BLOCK_CLOSE,
  ANSWER_BLOCK_OPEN,
  ASK_BLOCK_CLOSE,
  ASK_BLOCK_OPEN,
  displayName,
  neutraliseMarkers,
  rosterLine,
  type Section,
} from '@slave-of-ai/domain'

/**
 * The three sections only an IMPLEMENTATION run gets: what other slaves asked it, who those other
 * slaves are, and how to ask one back (M36 t3 and its final review, re-shaped by M37 Task 2).
 *
 * They are `Section`s rather than strings now, and this module no longer decides where any of them
 * goes: `runContext.ts` gathers them and `renderRunContext` (`@slave-of-ai/domain`) orders them.
 * The TEXT is unchanged from M36 except where the roster leaving the ask protocol required it --
 * see `askProtocolSection`.
 */

/**
 * The unanswered questions addressed to one slave, or `null` when there are none.
 *
 * **Deliberately minimal.** Only messages addressed to THIS slave (directly or by a role it holds),
 * only ones still expecting a reply, and nothing else about the world.
 * `listMessagesForSlave`'s `unansweredOnly` filter is exactly this set, scoped to the slave's own
 * workspace, and it never returns a slave its own sends.
 *
 * Nothing here marks anything read: a run that fails to spawn would otherwise consume the messages
 * it never showed anybody. `RunContext`'s `inbox` section source is the durable record of what was
 * actually put in front of the slave (M37 §2; it replaced `SlaveRun.suppliedMessageIds`).
 *
 * The answer instructions live in this section rather than in one of their own: they are only true
 * while there is something to answer, and `SECTION_ORDER.implementation` has no `answer_protocol`
 * slot precisely because an unconditional copy of them would be noise in every other run.
 */
export async function inboxSection(slaveId: string): Promise<Section | null> {
  const pending = await listMessagesForSlave(slaveId, { unansweredOnly: true })
  if (!pending.ok) {
    // The only refusal this call can return is `slave_not_found`, for a slave the dispatch just
    // read. Reported rather than thrown: an unreadable inbox must not stop a run from starting.
    console.warn(`[inbox] could not read the inbox of slave ${slaveId}: ${pending.error.kind}`)
    return null
  }
  if (pending.value.length === 0) return null

  const senders = await prisma.slave.findMany({
    where: { id: { in: [...new Set(pending.value.map((message) => message.senderSlaveId))] } },
    select: { id: true, name: true, role: true },
  })
  const nameById = new Map(senders.map((slave) => [slave.id, displayName(slave)]))

  const items = pending.value.map((message) => {
    const from = nameById.get(message.senderSlaveId) ?? message.senderSlaveId
    // Another party's text (M37 §1): a body that quoted `<slave-answer>` would otherwise answer on
    // the reader's behalf, or park the reader's run with a marker the reader never wrote.
    const body = neutraliseMarkers(message.body)
    return `- from ${from}, message id ${message.id}:\n  ${body.replaceAll('\n', '\n  ')}`
  })

  // The envelope is spelled out with a real message id from the list above, so the slave copies
  // rather than invents one. `apps/orchestrator/src/answer.ts` refuses an id it cannot match to a
  // question addressed to this slave, so an invented one costs the answer, not the run.
  const example = `${ANSWER_BLOCK_OPEN}{"messageId":"${pending.value[0]?.id ?? ''}","answer":"..."}${ANSWER_BLOCK_CLOSE}`
  const text = [
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

  return { kind: 'inbox', text, source: { kind: 'inbox', messageIds: pending.value.map((message) => message.id) } }
}

/**
 * How many peers the roster names before it stops (M36 final review, Important 2).
 *
 * The roster is there so a slave addresses somebody who exists rather than inventing a role; it is
 * not a directory. A large project would otherwise spend hundreds of prompt lines on names nobody
 * reads, and `recipientCanAnswer` (`ask.ts`) still validates whatever the slave writes -- the
 * roster is a hint, and a truncated hint is still a hint.
 */
const ROSTER_CAP = 25

/**
 * Who else is in this workspace, one `rosterLine` each, or `null` when this slave is alone.
 *
 * Its own section since M37: it is a fact about the workspace, not part of the ask protocol's
 * instructions, and the run-context order puts it near the top where a reader looks for "who is
 * here" rather than buried under a paragraph about envelopes.
 *
 * `rosterLine` (`@slave-of-ai/domain`) rather than a local format, and `runtimeRoles` rather than
 * `role`: the roles a slave may be DISPATCHED as are what a peer needs in order to address it,
 * while `role` is only its title. A slave with no runtime roles is still listed (`roles: none`) --
 * it can still answer a question addressed to it by id.
 */
export async function rosterSection(slaveId: string, workspaceId: string): Promise<Section | null> {
  const peers = await prisma.slave.findMany({
    where: { id: { not: slaveId }, team: { workspaceId } },
    select: { id: true, name: true, role: true, runtimeRoles: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    take: ROSTER_CAP,
  })
  if (peers.length === 0) return null

  const text = [
    'SLAVES YOU CAN ADDRESS',
    '',
    ...peers.map((peer) => `- ${rosterLine(peer)}`),
    '',
    '---',
  ].join('\n')

  return { kind: 'roster', text, source: { kind: 'roster', slaveIds: peers.map((peer) => peer.id) } }
}

/**
 * The few lines that teach an implementation run HOW to ask (M36 final review, Important 2).
 *
 * Nothing taught a slave the `<slave-ask>` envelope before M36: the whole waiting loop existed and
 * could not fire in production, because a model has no way to guess a tag it has never been shown.
 * The markers come from `packages/domain/src/messaging/ask.ts` rather than being written out here,
 * so the string the parser looks for and the string the prompt teaches cannot drift apart -- and
 * they are the one text `neutraliseMarkers` is never applied to, because this section is what
 * TEACHES the real markers.
 *
 * **IMPLEMENTATION runs only, and only alongside a roster.** `ask.ts` refuses an ask from a review
 * run, and `recipientCanAnswer` refuses every recipient a lone slave could name -- `runContext.ts`
 * enforces both conditions, which is why this producer takes no arguments and never returns `null`.
 *
 * The roster it used to end with is now its own section, above: the two references that pointed
 * "below" point at it by name instead.
 */
export function askProtocolSection(): Section {
  const text = [
    'ASKING ANOTHER SLAVE',
    '',
    'If you cannot continue without an answer somebody else has to give, do not guess. End your',
    'FINAL message with one block like this and stop there:',
    `${ASK_BLOCK_OPEN}{"role":"<a role from the roster above>","question":"..."}${ASK_BLOCK_CLOSE}`,
    `Use "slaveId":"<an id from the roster above>" instead of "role" to ask one slave by name. Add`,
    '"context":"..." for anything the answerer needs to know first.',
    '',
    'Your run stops there. That is not a failure: it costs you no attempt, and you are resumed in',
    'this same session, in this same worktree, with the answer in front of you. Ask only when you',
    'are genuinely stuck; finish the task otherwise.',
    '',
    '---',
  ].join('\n')

  return { kind: 'ask_protocol', text, source: { kind: 'ask_protocol' } }
}
