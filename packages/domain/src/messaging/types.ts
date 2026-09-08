/**
 * The worker-protocol role a message plays (M36 t1). Orthogonal to `MessageCategory`
 * (`slave.message_sent`'s pre-existing, still-unused classification of a HUMAN instruction --
 * `packages/domain/src/events/schema.ts`): a worker-authored message never carries a
 * `MessageCategory`, and a human-authored one never carries a `MessageKind`.
 *
 * `question` is what M36's ask/wait loop sends when a worker cannot continue without an answer
 * (`expectsReply: true`); `answer` is Task 3's reply to one. `information`, `blocker`, and
 * `handoff` are the shapes M36's plan names for a worker that has something to say but is not
 * blocked waiting for a reply.
 */
export const MESSAGE_KINDS = ['question', 'answer', 'information', 'blocker', 'handoff'] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

/**
 * Who a message is addressed to: a named worker, or every worker currently holding a role.
 * Exactly one of the two must be set -- see {@link isValidRecipient}.
 */
export interface MessageRecipient {
  readonly slaveId: string | null
  readonly role: string | null
}

/**
 * `sendMessage` (packages/control/src/messaging.ts) refuses a recipient this returns `false` for,
 * before writing anything -- the database does not enforce it. Neither identifies nobody; both is
 * ambiguous about whether a role or a specific worker should receive it.
 */
export function isValidRecipient(recipient: MessageRecipient): boolean {
  const hasSlave = recipient.slaveId !== null && recipient.slaveId.trim() !== ''
  const hasRole = recipient.role !== null && recipient.role.trim() !== ''
  return hasSlave !== hasRole
}

/**
 * A `SlaveMessage` row, as control reads it back. Independent of the Prisma row shape on purpose,
 * the same discipline `FoldEvent` (apps/web/src/lib/communicationFold.ts) follows for
 * `ExecutionEvent` -- this is the read model Task 2/3 build on, not a reflection of the table.
 */
export interface SlaveMessageView {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string | null
  readonly threadId: string
  readonly replyToId: string | null
  readonly senderSlaveId: string
  readonly senderRunId: string | null
  readonly recipientSlaveId: string | null
  readonly recipientRole: string | null
  readonly kind: MessageKind
  readonly body: string
  readonly expectsReply: boolean
  readonly readAt: string | null
  readonly createdAt: string
}
