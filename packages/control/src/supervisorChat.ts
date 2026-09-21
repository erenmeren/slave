import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  ATTACHMENT_KIND_BY_EXTENSION,
  CHAT_HISTORY_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  TIERS,
  actionSchema,
  err,
  ok,
  type Action,
  type ChatAttachment,
  type Result,
  type Tier,
} from '@slave-of-ai/domain'
import type { ProviderKind } from '@slave-of-ai/providers'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { SUPERVISOR_UPLOAD_MAX_FILES, isInboxPath } from './supervisorUploads.js'

/**
 * How long a claimed turn is held before another daemon may take it (F R2).
 *
 * `INTAKE_CLAIM_TTL_MS`' own number and its own reason: the process that claimed it may be gone,
 * and a conversation stuck forever behind a dead daemon is the failure this exists to prevent.
 * Five minutes is well past `DEFAULT_MODEL_TIMEOUT_MS` for one call, so a turn that is genuinely
 * in flight is never stolen from the process paying for it.
 */
export const SUPERVISOR_CHAT_CLAIM_TTL_MS = 5 * 60 * 1000

/** The reason a claimed turn fails when its own rows cannot be read back (fix round 1, M3): a
 *  placeholder with no human message before it, or a project that vanished between the claim and
 *  the read. A claim is held for {@link SUPERVISOR_CHAT_CLAIM_TTL_MS}, so dropping such a row
 *  silently left the panel saying "thinking" for five minutes and then trying again forever. */
export const TURN_UNREADABLE_REASON = 'turn_unreadable'

/** One line of the conversation as a reader sees it. `createdAt` is an ISO string so a web route
 *  can serialise the view unchanged -- `IntakeMessageView`'s own rule. */
export interface SupervisorMessageView {
  readonly id: string
  readonly seq: number
  readonly role: 'human' | 'supervisor'
  readonly status: 'sent' | 'answering' | 'answered' | 'failed'
  readonly text: string
  readonly attachments: readonly ChatAttachment[]
  /** R3: what the reply proposed, each with the decision it became and the tier that decided
   *  whether it was applied or is waiting. Null on a human row and on a reply that asked for
   *  nothing, which is most of them. */
  readonly actions: readonly SupervisorMessageAction[] | null
  readonly modelCostUsd: number | null
  /** R2's chip: every citation this reply made checked out against what its own prompt rendered,
   *  and it made at least one. False on a reply that cited nothing -- which is an ordinary reply,
   *  not a suspect one: this is a conversation, not a sourced answer to a worker. */
  readonly sourced: boolean
  /** The call happened and nobody could price it (a Cursor turn, erratum E2). NOT the same as a
   *  cost of zero, and the panel must not add it up as one -- though the BUDGET does, at the
   *  per-call cap (erratum E11). False on a turn that threw before the spawn: that one cost
   *  nothing, and there is no silence about money to be honest about (I4). */
  readonly unmeasured: boolean
  readonly failureReason: string | null
  readonly createdAt: string
}

/** One action a reply asked for, as the row stores it (R3). */
export interface SupervisorMessageAction {
  readonly action: Action
  readonly decisionId: string
  readonly tier: Tier
}

/**
 * What one turn is answered FROM, handed over by {@link claimSupervisorTurns}.
 *
 * Everything that comes off the conversation's own rows. The world, the feed and the needs-you
 * list are read by the tick from elsewhere, so this is the part that is a fact about the
 * conversation and nothing else.
 */
export interface ClaimedSupervisorTurn {
  /** The `answering` SUPERVISOR row -- the placeholder this turn will settle. */
  readonly id: string
  readonly workspaceId: string
  /** The person's message this turn answers: the human row directly before the placeholder. */
  readonly message: string
  readonly attachments: readonly ChatAttachment[]
  /** The last {@link CHAT_HISTORY_MAX} turns BEFORE this exchange -- answered replies and the
   *  people's messages that drew them. The message above is not in here; the prompt puts it at the
   *  end itself. */
  readonly history: readonly { readonly role: 'human' | 'supervisor'; readonly text: string }[]
  /** R4: null means the installation default on both. */
  readonly provider: ProviderKind | null
  readonly model: string | null
}

/** What one settled turn came to (R2). `unmeasured` travels beside `costUsd` rather than being
 *  derived from it: a call that cost nothing and a call nobody could price are different facts,
 *  and only one of them is honest to add up. */
export type SupervisorReplyOutcome =
  | {
      readonly kind: 'answered'
      readonly text: string
      readonly actions: readonly SupervisorMessageAction[]
      /** `isSourced` over the citation check this turn ran (R2). Stored rather than re-derived:
       *  the feed window and the attachment slices it was checked against are gone by the time
       *  anybody reads the row. */
      readonly sourced: boolean
      readonly costUsd: number | null
      readonly unmeasured: boolean
    }
  | {
      readonly kind: 'failed'
      /** Why there is no reply. Reaches the panel: a person watching a thread go quiet has no
       *  other way to learn that the failure was not theirs. */
      readonly reason: string
      readonly costUsd: number | null
      readonly unmeasured: boolean
    }

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

/** A stored `attachments` column, read back defensively: a hand-edited row or one written by a
 *  future version must not take the panel down (`listGoalVersions`' rule for a `Json` column). An
 *  entry that is not an attachment is dropped rather than guessed at. */
function parseAttachments(value: Prisma.JsonValue | null): readonly ChatAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): readonly ChatAttachment[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const row = raw as Record<string, unknown>
    const { path, name, bytes, kind } = row
    if (typeof path !== 'string' || typeof name !== 'string' || typeof bytes !== 'number') return []
    if (kind !== 'text' && kind !== 'image' && kind !== 'binary') return []
    return [{ path, name, bytes, kind }]
  })
}

/** A stored `actions` column, read back on the same terms -- and the ACTION through the domain's
 *  own `actionSchema`, never cast: this column is read back months later, and a row written by a
 *  build whose catalogue has since changed must degrade to "this entry is not readable" rather
 *  than reach the panel as a shape it will render wrong. `null` is the ordinary state. */
function parseActions(value: Prisma.JsonValue | null): readonly SupervisorMessageAction[] | null {
  if (value === null || !Array.isArray(value)) return null
  return value.flatMap((raw): readonly SupervisorMessageAction[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const row = raw as Record<string, unknown>
    const tier = row['tier']
    if (typeof row['decisionId'] !== 'string' || typeof tier !== 'string') return []
    if (!(TIERS as readonly string[]).includes(tier)) return []
    const action = actionSchema.safeParse(row['action'])
    if (!action.success) return []
    return [{ action: action.data, decisionId: row['decisionId'], tier: tier as Tier }]
  })
}

const viewOf = (row: {
  id: string
  seq: number
  role: 'human' | 'supervisor'
  status: 'sent' | 'answering' | 'answered' | 'failed'
  text: string
  attachments: Prisma.JsonValue
  actions: Prisma.JsonValue | null
  modelCostUsd: number | null
  sourced: boolean
  unmeasured: boolean
  failureReason: string | null
  createdAt: Date
}): SupervisorMessageView => ({
  id: row.id,
  seq: row.seq,
  role: row.role,
  status: row.status,
  text: row.text,
  attachments: parseAttachments(row.attachments),
  actions: parseActions(row.actions),
  modelCostUsd: row.modelCostUsd,
  sourced: row.sourced,
  unmeasured: row.unmeasured,
  failureReason: row.failureReason,
  createdAt: row.createdAt.toISOString(),
})

async function nextSeq(tx: Prisma.TransactionClient, workspaceId: string): Promise<number> {
  const last = await tx.supervisorMessage.findFirst({
    where: { workspaceId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  return (last?.seq ?? -1) + 1
}

/**
 * The person's line, and the reply placeholder, in ONE transaction (F R1/R2).
 *
 * Two rows, always: a `human` row with `status: sent` and a `supervisor` row with
 * `status: answering`, which is what makes the panel show "thinking" the instant the message is
 * sent rather than after the next tick claims it. They are written together because a human row
 * with no placeholder is a message nothing will ever answer -- the tick claims PLACEHOLDERS -- and
 * a placeholder with no message is a turn with nothing to read.
 *
 * `SELECT ... FOR UPDATE` on the project, `recordDecision`'s idiom, for the same reason: the seq
 * is a read followed by an insert, and `@@unique([workspaceId, seq])` turns two concurrent sends
 * into a thrown Prisma error rather than into two turns.
 *
 * Every refusal is decided BEFORE the transaction opens or inside it before anything is written,
 * so returning one is safe -- a refusal after a write would have to throw or Prisma would commit
 * that write.
 */
export async function sendSupervisorMessage(
  workspaceId: string,
  input: { readonly text: string; readonly attachments?: readonly ChatAttachment[] },
  _principal?: Principal,
): Promise<Result<{ readonly messageId: string; readonly replyId: string }, ControlRefusal>> {
  const text = input.text.trim()
  if (text === '') return err({ kind: 'invalid_message', reason: 'a message must not be blank' })
  if (text.length > CHAT_MESSAGE_MAX_CHARS) {
    return err({
      kind: 'invalid_message',
      reason:
        `a message must be at most ${String(CHAT_MESSAGE_MAX_CHARS)} characters; this one is ${String(text.length)}. ` +
        'Anything longer is a specification -- put it in the goal, or attach it as a file',
    })
  }

  const attachments = input.attachments ?? []
  if (attachments.length > SUPERVISOR_UPLOAD_MAX_FILES) {
    return err({ kind: 'too_many_attachments', limit: SUPERVISOR_UPLOAD_MAX_FILES, count: attachments.length })
  }
  // What is STORED, never what was posted (fix round 1, M5). `kind` is DERIVED from the path's own
  // extension through `ATTACHMENT_KIND_BY_EXTENSION` -- the one place an extension becomes a kind
  // -- and the caller's `kind` is ignored entirely. It is a field on a request body, which means a
  // caller can say `image` about a `.md`, and the kind is what decides whether the chat prompt
  // INLINES the file's text or only names it by path: believing the caller would let a request
  // hide a brief from the prompt, or ask for a screenshot to be read as text. `bytes` stays as
  // posted -- it is what the upload verb measured and nothing here re-reads the file.
  const stored: ChatAttachment[] = []
  for (const attachment of attachments) {
    // R6: an attachment IS a file in `docs/inbox` -- that is what `storeSupervisorUploads` makes
    // and the only thing the prompt promises a worker can open by path. A path from anywhere else
    // arrived through a caller that did not go through the upload verb, and naming an arbitrary
    // file in the repository is not what a person attaching a brief asked for.
    if (!isInboxPath(attachment.path)) return err({ kind: 'attachment_path_refused', name: attachment.name })
    const extension = attachment.path.slice(attachment.path.lastIndexOf('.') + 1).toLowerCase()
    const kind = ATTACHMENT_KIND_BY_EXTENSION[extension]
    if (kind === undefined) {
      return err({ kind: 'attachment_kind_not_allowed', name: attachment.name, extension })
    }
    stored.push({ path: attachment.path, name: attachment.name, bytes: attachment.bytes, kind })
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
      SELECT id, "archivedAt" FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = locked[0]
    if (workspace === undefined) {
      return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    }
    // I5, and under the SAME lock the seq is read under rather than before the transaction opens:
    // archiving is a write on this row, so a check outside it could pass for a project archived a
    // millisecond later and leave a turn nothing will answer. `workspace_archived` is the refusal
    // every other write path on an archived project already gives, and no row has been written yet
    // -- a returned `err` inside a transaction COMMITS whatever came before it, and here nothing has.
    if (workspace.archivedAt !== null) {
      return { ok: false as const, error: { kind: 'workspace_archived', workspaceId } as ControlRefusal }
    }
    const seq = await nextSeq(tx, workspaceId)
    const message = await tx.supervisorMessage.create({
      data: { workspaceId, seq, role: 'human', status: 'sent', text, attachments: asJson(stored) },
      select: { id: true },
    })
    const reply = await tx.supervisorMessage.create({
      // The placeholder carries no text: there is no reply yet, and an invented one ("thinking…")
      // would be a sentence the panel has to know to hide and a reader months later has to know
      // was never said.
      data: { workspaceId, seq: seq + 1, role: 'supervisor', status: 'answering', text: '' },
      select: { id: true },
    })
    return { ok: true as const, messageId: message.id, replyId: reply.id }
  })
  return outcome.ok ? ok({ messageId: outcome.messageId, replyId: outcome.replyId }) : err(outcome.error)
}

/**
 * Moves up to `limit` waiting turns to this daemon and hands them back (F R2).
 *
 * ONE statement, and raw for `claimIntakes`' reason: Prisma's `updateMany` returns a count rather
 * than rows. `FOR UPDATE SKIP LOCKED` inside the sub-select is the property two daemons depend on
 * -- the second claimer SKIPS a row the first has locked instead of waiting for it, so neither
 * answers the same message and neither blocks.
 *
 * A row whose claim is older than {@link SUPERVISOR_CHAT_CLAIM_TTL_MS} is due again: the process
 * that held it is gone. The status does not change on a claim -- `answering` is already what the
 * panel draws as "thinking", and a fourth status for "claimed" would be a state nobody renders.
 * The claim is `claimedAt`/`claimedBy`, which is what the TTL and a stuck-row report read.
 *
 * AN ARCHIVED PROJECT IS NEVER CLAIMED (final fix wave, I5). Archiving is how a person says "stop
 * spending on this", and every other write path already refuses one; a turn sent before the archive
 * -- or a row still `answering` when it happened -- would otherwise be answered afterwards, paying a
 * vendor for a conversation about a project nobody is working on. It is left `answering` rather than
 * failed: un-archiving is a thing a person does, and the turn is then due again, exactly as a
 * stale claim is.
 */
export async function claimSupervisorTurns(input: {
  readonly by: string
  readonly limit: number
  readonly now?: Date
}): Promise<readonly ClaimedSupervisorTurn[]> {
  if (input.limit <= 0) return []
  const now = input.now ?? new Date()
  const stale = new Date(now.getTime() - SUPERVISOR_CHAT_CLAIM_TTL_MS)
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "SupervisorMessage" SET "claimedAt" = ${now}, "claimedBy" = ${input.by}
    WHERE "id" IN (
      SELECT m."id" FROM "SupervisorMessage" m
      WHERE m."status" = 'answering'
        AND (m."claimedAt" IS NULL OR m."claimedAt" < ${stale})
        -- EXISTS AND NOT A JOIN: FOR UPDATE SKIP LOCKED locks every table in the FROM list, so a
        -- join would lock the Workspace row too -- and then SKIP would drop a perfectly good turn
        -- whose project some other transaction happened to be holding. A subquery is not locked, so
        -- m stays the only table this statement takes a lock on.
        AND EXISTS (
          SELECT 1 FROM "Workspace" w WHERE w."id" = m."workspaceId" AND w."archivedAt" IS NULL
        )
      ORDER BY m."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    RETURNING "id"`

  const turns: ClaimedSupervisorTurn[] = []
  for (const { id } of claimed) {
    const turn = await readClaimedTurn(id)
    if (turn !== null) {
      turns.push(turn)
      continue
    }
    // FAILED, never silently dropped (fix round 1, M3). The claim has already been written, so a
    // row skipped here is one this pass will not answer and the next pass cannot touch for five
    // minutes -- and then will skip again, for the same reason, forever. A person watching would
    // see "thinking" with nothing behind it.
    const settled = await recordSupervisorReply(id, {
      kind: 'failed',
      reason: TURN_UNREADABLE_REASON,
      costUsd: null,
      unmeasured: false,
    })
    if (!settled.ok) process.stderr.write(`[chat] ${id}: ${refusalText(settled.error)}\n`)
  }
  return turns
}

/** Everything one claimed placeholder needs off its own conversation: the message before it, and
 *  the `CHAT_HISTORY_MAX` turns before that. Null when the placeholder has no message before it at
 *  all, which is a row `sendSupervisorMessage` cannot produce and a hand-written one can. */
async function readClaimedTurn(id: string): Promise<ClaimedSupervisorTurn | null> {
  const placeholder = await prisma.supervisorMessage.findUnique({
    where: { id },
    select: { workspaceId: true, seq: true },
  })
  if (placeholder === null) return null
  const workspace = await prisma.workspace.findUnique({
    where: { id: placeholder.workspaceId },
    select: { supervisorProvider: true, supervisorModel: true },
  })
  if (workspace === null) return null

  // The whole window in one read, newest first, then reversed: the message this turn answers is
  // the newest row before the placeholder, and the history is the `CHAT_HISTORY_MAX` before that.
  // `failed` and `answering` rows are left out -- a reply that never came is not something to
  // quote back at the model as though it had said it.
  const before = await prisma.supervisorMessage.findMany({
    where: {
      workspaceId: placeholder.workspaceId,
      seq: { lt: placeholder.seq },
      status: { in: ['sent', 'answered'] },
    },
    orderBy: { seq: 'desc' },
    take: CHAT_HISTORY_MAX + 1,
    select: { role: true, text: true, attachments: true },
  })
  const [asked, ...older] = before
  if (asked === undefined || asked.role !== 'human') return null
  return {
    id,
    workspaceId: placeholder.workspaceId,
    message: asked.text,
    attachments: parseAttachments(asked.attachments),
    history: older.reverse().map((row) => ({ role: row.role, text: row.text })),
    provider: workspace.supervisorProvider,
    model: workspace.supervisorModel,
  }
}

/**
 * Writes what one turn came to (F R2), and releases the claim.
 *
 * ONLY THE PLACEHOLDER THAT IS STILL `answering` MAY BE WRITTEN -- `recordIntakeReply`'s rule and
 * for its reason: a TTL reclaim can race the call that is still out, and a turn recorded twice is
 * two replies and two charges for one message. The status is re-read under the same `FOR UPDATE`
 * lock the write takes, and anything else refuses before a byte is written.
 *
 * The call is charged whatever it came to. A failed turn cost money.
 */
export async function recordSupervisorReply(
  messageId: string,
  outcome: SupervisorReplyOutcome,
): Promise<Result<void, ControlRefusal>> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SupervisorMessage" WHERE id = ${messageId} FOR UPDATE`
    const row = await tx.supervisorMessage.findUnique({ where: { id: messageId }, select: { status: true } })
    if (row === null) return { ok: false as const, error: { kind: 'message_not_found', messageId } as ControlRefusal }
    if (row.status !== 'answering') {
      return { ok: false as const, error: { kind: 'message_not_answering', messageId, status: row.status } as ControlRefusal }
    }
    await tx.supervisorMessage.update({
      where: { id: messageId },
      data: {
        status: outcome.kind === 'answered' ? 'answered' : 'failed',
        text: outcome.kind === 'answered' ? outcome.text : '',
        // Omitted rather than written as a JSON null when there is none: the column is nullable
        // and `Prisma.DbNull` would need a value import of `Prisma` this module does not take.
        ...(outcome.kind === 'answered' && outcome.actions.length > 0 ? { actions: asJson(outcome.actions) } : {}),
        sourced: outcome.kind === 'answered' && outcome.sourced,
        ...(outcome.kind === 'failed' ? { failureReason: outcome.reason } : {}),
        modelCostUsd: outcome.costUsd,
        unmeasured: outcome.unmeasured,
        claimedAt: null,
        claimedBy: null,
      },
    })
    return { ok: true as const }
  })
  return result.ok ? ok(undefined) : err(result.error)
}

/** The conversation, oldest first -- the panel's and the CLI's read side. `limit` bounds the
 *  NEWEST end, because a thread is read from the bottom. */
export async function listSupervisorMessages(
  workspaceId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly SupervisorMessageView[]> {
  const take = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 500)
  const rows = await prisma.supervisorMessage.findMany({
    where: { workspaceId },
    orderBy: { seq: 'desc' },
    take,
  })
  return rows.reverse().map(viewOf)
}

/** What this conversation has cost (R8's "cost so far"). `unmeasured` is COUNTED rather than
 *  folded into the total at a cap: a Cursor turn reports no price at all (erratum E2), and the
 *  only honest thing a panel can show is the money that was measured and the number of turns that
 *  were not. */
export async function conversationCost(
  workspaceId: string,
): Promise<{ readonly usd: number; readonly unmeasuredTurns: number }> {
  const [measured, unmeasured] = await Promise.all([
    prisma.supervisorMessage.aggregate({ where: { workspaceId }, _sum: { modelCostUsd: true } }),
    prisma.supervisorMessage.count({ where: { workspaceId, unmeasured: true } }),
  ])
  return { usd: measured._sum.modelCostUsd ?? 0, unmeasuredTurns: unmeasured }
}
