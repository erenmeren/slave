import { goalEventWith, withDeliveryLock } from '@slave-of-ai/control'
import type { Prisma } from '@slave-of-ai/db/client'
import { readLeadProgress, renderLeadStop, type LeadProgress, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { progressJson } from './record.js'

/**
 * Lead-flow spec D2 / P7 (plan A L12/L13): a lead-flow version's loop ends without acceptance.
 * Inside the delivery's lock: from `integrating` or `verifying` to the existing `needs_human`, with
 * every claim released, the text of the one card (`renderLeadStop`), the state word and the stop
 * reason, in one guarded write. The card is raised from the ROW (the Supervisor's existing
 * `goal_needs_human` rule), never from an event.
 *
 * The two events are written BEFORE the move and are not part of the lock's transaction:
 * `appendEvent` commits on its own. A caller whose transaction then rolls back leaves them with no
 * move behind them, so each is written once per stop -- skipped when the version's log already has
 * it since the last `workspace.goal_retried` (`needsHumanInLock`'s rule: a version stops at most
 * once between two retries) -- and the stop that does commit does not say it twice. Returns whether
 * this call stopped it.
 */
export async function stopLeadInLock(tx: Prisma.TransactionClient, deliveryId: string, reason: StopReason, progress: LeadProgress, detail: string | null): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  if (delivery.status !== 'integrating' && delivery.status !== 'verifying') return false
  const text = renderLeadStop({ version: delivery.goalVersion, reason, failing: progress.failing, disputed: progress.disputed, unverifiable: progress.unverifiable, detail })
  const { workspaceId, goalVersion: version } = delivery
  const lastRetry = await tx.executionEvent.findFirst({
    where: { workspaceId, type: 'workspace_goal_retried', payload: { path: ['version'], equals: version } },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const since = lastRetry === null ? {} : { since: lastRetry.seq }
  if (!(await goalEventWith(tx, workspaceId, 'workspace_goal_needs_human', { version }, since))) {
    await appendEvent({ type: 'workspace.goal_needs_human', workspaceId, actor: 'system', payload: { version, reason: text } })
  }
  if (!(await goalEventWith(tx, workspaceId, 'workspace_lead_state', { version, state: 'awaiting_decision' }, since))) {
    await appendEvent({ type: 'workspace.lead_state', workspaceId, actor: 'system', payload: { version, state: 'awaiting_decision', reason } })
  }
  // Under the lock the status read above still holds, so this guarded write moves the row.
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
  return moved.count > 0
}

/** {@link stopLeadInLock} for a caller holding no lock, on the version's stored progress. */
export async function stopLead(deliveryId: string, reason: StopReason, detail: string | null): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { leadProgress: true } })
    return stopLeadInLock(tx, deliveryId, reason, readLeadProgress(row.leadProgress), detail)
  })
}
