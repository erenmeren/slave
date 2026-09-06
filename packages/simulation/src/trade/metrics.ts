import type { JournalEntry } from '../core/journal.js'
import { unpaidCommitmentsMinor, type TradeState } from './state.js'

export interface TradeMetrics {
  readonly deliveredQty: number
  readonly onTimeQty: number
  readonly lateDays: number
  readonly purchaseCostMinor: number
  readonly closingInventory: number
  readonly closingCashMinor: number
  readonly minCashMinor: number
  readonly minCashDay: number
  readonly collectedMinor: number
  readonly unpaidCommitmentsMinor: number
  /** Which journal kinds / state fields each derived figure reads — shown beside the number. */
  readonly sources: Readonly<Record<'deliveredQty' | 'lateDays' | 'purchaseCostMinor' | 'collectedMinor' | 'unpaidCommitmentsMinor', readonly string[]>>
}

function actionType(entry: JournalEntry): string | null {
  const action = entry.payload['action']
  return typeof action === 'object' && action !== null && 'type' in action ? String((action as { type: unknown }).type) : null
}
function eventType(entry: JournalEntry): string | null {
  const event = entry.payload['event']
  return typeof event === 'object' && event !== null && 'type' in event ? String((event as { type: unknown }).type) : null
}

/** Every figure comes from the journal or the closing state; nothing is estimated. */
export function tradeMetrics(entries: readonly JournalEntry[], state: TradeState): TradeMetrics {
  const dueByOrder = new Map(state.orders.map((o) => [o.id, o.dueDay]))
  let deliveredQty = 0
  let onTimeQty = 0
  let purchaseCostMinor = 0
  let collectedMinor = 0
  for (const entry of entries) {
    if (entry.kind === 'action_applied' && actionType(entry) === 'ship_order') {
      const qty = Number(entry.payload['shipped'] ?? 0)
      deliveredQty += qty
      const orderId = String((entry.payload['action'] as { params?: { orderId?: unknown } }).params?.orderId ?? '')
      const due = dueByOrder.get(orderId)
      if (due !== undefined && entry.simTime <= due) onTimeQty += qty
    }
    if (entry.kind === 'action_applied' && actionType(entry) === 'place_purchase') purchaseCostMinor += Number(entry.payload['costMinor'] ?? 0)
    if (entry.kind === 'event' && eventType(entry) === 'collection') collectedMinor += Number(entry.payload['collectedMinor'] ?? 0)
  }
  const lateDays = state.orders.reduce((sum, o) => sum + (o.lastShipDay !== null && o.status === 'shipped' ? Math.max(0, o.lastShipDay - o.dueDay) : 0), 0)
  return {
    deliveredQty, onTimeQty, lateDays, purchaseCostMinor, closingInventory: state.inventory, closingCashMinor: state.cashMinor,
    minCashMinor: state.minCashMinor, minCashDay: state.minCashDay, collectedMinor, unpaidCommitmentsMinor: unpaidCommitmentsMinor(state),
    sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] },
  }
}
