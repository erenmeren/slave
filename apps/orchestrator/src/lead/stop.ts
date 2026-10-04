import { withDeliveryLock } from '@slave-of-ai/control'
import type { Prisma } from '@slave-of-ai/db/client'
import { readLeadProgress, renderLeadStop, type LeadProgress, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { progressJson } from './record.js'

/**
 * Lead-flow spec D2 / P7 (plan A L12/L13): a lead-flow version's loop ends without acceptance.
 * Inside the delivery's lock: from `integrating` or `verifying` to the existing `needs_human`, with
 * every claim released, the text of the one card (`renderLeadStop`), the state word and the stop
 * reason, in one guarded write. The two events follow the move: the card is raised from the ROW
 * (the Supervisor's existing `goal_needs_human` rule), so a crash between the two loses a timeline
 * line and never the card. Returns whether this call stopped it.
 */
export async function stopLeadInLock(tx: Prisma.TransactionClient, deliveryId: string, reason: StopReason, progress: LeadProgress, detail: string | null): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  if (delivery.status !== 'integrating' && delivery.status !== 'verifying') return false
  const text = renderLeadStop({ version: delivery.goalVersion, reason, failing: progress.failing, disputed: progress.disputed, unverifiable: progress.unverifiable, detail })
  const moved = await tx.goalDelivery.updateMany({
    where: { id: deliveryId, status: { in: ['integrating', 'verifying'] } },
    data: {
      status: 'needs_human',
      activeRunId: null,
      activeSmokeId: null,
      needsHumanReason: text,
      leadState: 'awaiting_decision',
      stopReason: reason,
      leadProgress: progressJson({ ...progress, nextTurn: null, confirm: null }),
    },
  })
  if (moved.count === 0) return false
  await appendEvent({ type: 'workspace.goal_needs_human', workspaceId: delivery.workspaceId, actor: 'system', payload: { version: delivery.goalVersion, reason: text } })
  await appendEvent({ type: 'workspace.lead_state', workspaceId: delivery.workspaceId, actor: 'system', payload: { version: delivery.goalVersion, state: 'awaiting_decision', reason } })
  return true
}

/** {@link stopLeadInLock} for a caller holding no lock, on the version's stored progress. */
export async function stopLead(deliveryId: string, reason: StopReason, detail: string | null): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { leadProgress: true } })
    return stopLeadInLock(tx, deliveryId, reason, readLeadProgress(row.leadProgress), detail)
  })
}
