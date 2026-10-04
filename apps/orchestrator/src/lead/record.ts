import { withDeliveryLock } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  LEAD_NOTE_DETAIL_MAX_CHARS,
  LEAD_TURN_NOTE_MAX_CHARS,
  leadProgressSchema,
  readLeadProgress,
  storableText,
  trimToFit,
  type LeadNoteKind,
  type LeadProgress,
  type StopReason,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'

/** One line for the report about a lead-flow version (`workspace.lead_noted`). Never a card. */
export async function noteLead(input: { readonly workspaceId: string; readonly version: number; readonly kind: LeadNoteKind; readonly detail: string; readonly runId?: string | null }): Promise<void> {
  const detail = trimToFit(storableText(input.detail).trim(), LEAD_NOTE_DETAIL_MAX_CHARS)
  await appendEvent({
    type: 'workspace.lead_noted',
    workspaceId: input.workspaceId,
    actor: 'system',
    ...(input.runId == null ? {} : { runId: input.runId }),
    payload: { version: input.version, kind: input.kind, detail: detail === '' ? input.kind : detail, runId: input.runId ?? null },
  })
}

/** {@link noteLead}, unless the version already has this very line: a standing fact is said once. */
export async function noteLeadOnce(input: Parameters<typeof noteLead>[0]): Promise<void> {
  const said = await prisma.executionEvent.findFirst({
    where: {
      workspaceId: input.workspaceId,
      type: 'workspace_lead_noted',
      AND: [{ payload: { path: ['version'], equals: input.version } }, { payload: { path: ['kind'], equals: input.kind } }, { payload: { path: ['detail'], equals: input.detail } }],
    },
    select: { seq: true },
  })
  if (said === null) await noteLead(input)
}

/**
 * `LeadProgress` as the JSON column takes it -- or a throw. The turn note is cut to its stored bound
 * first (it carries a verifier's evidence or a failure: another party's text, of any length). Then
 * the whole is checked against `leadProgressSchema`, because `readLeadProgress` reads a row that
 * does not parse as the INITIAL progress: one bad field written here would silently wipe
 * `leadEnded`, `askReplies` and `baseMerges` on the next read (Task 1 review). Every writer calls
 * this inside the delivery's lock (or the plan's own write), so the throw rolls the write back.
 */
export function progressJson(progress: LeadProgress): Prisma.InputJsonValue {
  const bounded: LeadProgress =
    progress.nextTurn === null ? progress : { ...progress, nextTurn: { ...progress.nextTurn, note: trimToFit(progress.nextTurn.note, LEAD_TURN_NOTE_MAX_CHARS) } }
  const parsed = leadProgressSchema.safeParse(bounded)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`refusing to store a lead progress that does not parse (${issue === undefined ? 'unknown' : `${issue.path.join('.')}: ${issue.message}`})`)
  }
  return parsed.data as unknown as Prisma.InputJsonValue
}

/** Reads, changes and writes a version's progress under its delivery lock; returns what was written. */
export async function updateLeadProgress(deliveryId: string, change: (progress: LeadProgress) => LeadProgress): Promise<LeadProgress> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { leadProgress: true } })
    const next = progressJson(change(readLeadProgress(row.leadProgress)))
    await tx.goalDelivery.update({ where: { id: deliveryId }, data: { leadProgress: next } })
    return readLeadProgress(next)
  })
}

/**
 * Plan A L6/L7: the lead gets no further turn -- its share of the budget or the goal's time is
 * spent. Set once (the first reason stands) and said once. Returns whether this call ended it.
 */
export async function endLead(deliveryId: string, reason: StopReason, detail: string): Promise<boolean> {
  let ended = false
  await updateLeadProgress(deliveryId, (progress) => {
    if (progress.leadEnded !== null) return progress
    ended = true
    return { ...progress, leadEnded: reason, nextTurn: null }
  })
  if (ended) {
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { workspaceId: true, goalVersion: true } })
    await noteLead({ workspaceId: delivery.workspaceId, version: delivery.goalVersion, kind: 'lead_ended', detail })
  }
  return ended
}
