import { describe, expect, it } from 'vitest'
import type { JournalEntry } from '../../src/core/journal.js'
import { tradeMetrics } from '../../src/trade/metrics.js'
import { initialTradeState } from '../../src/trade/state.js'

const e = (seq: number, simTime: number, kind: JournalEntry['kind'], payload: Record<string, unknown>): JournalEntry => ({ seq, simTime, kind, actorRole: null, payload })

describe('tradeMetrics', () => {
  it('computes each figure from the journal kinds it names, on a hand-checked three-day fixture', () => {
    const state = { ...initialTradeState({ cashMinor: 1_000, inventory: 5, dailyShipCapacity: 10, suppliers: [] }), cashMinor: 700, minCashMinor: 400, minCashDay: 2, orders: [{ id: 'order-1', qty: 12, remaining: 0, unitPriceMinor: 100, dueDay: 1, collectInDays: 0, shippedQty: 12, lastShipDay: 3, status: 'shipped' as const }], purchases: [{ id: 'purchase-1', supplierId: 's', qty: 7, unitPriceMinor: 50, orderedDay: 0, expectedDay: 1, deliveredDay: 1, payDay: 9, status: 'delivered' as const, paid: false }] }
    const entries = [
      e(1, 0, 'action_applied', { action: { type: 'place_purchase' }, costMinor: 350 }),
      e(2, 1, 'action_applied', { action: { type: 'ship_order', params: { orderId: 'order-1' } }, shipped: 5 }),
      e(3, 3, 'action_applied', { action: { type: 'ship_order', params: { orderId: 'order-1' } }, shipped: 7 }),
      e(4, 3, 'event', { event: { type: 'collection' }, collectedMinor: 1_200 }),
    ]
    expect(tradeMetrics(entries, state)).toEqual({
      deliveredQty: 12, onTimeQty: 5, lateDays: 2, purchaseCostMinor: 350, closingInventory: 5, closingCashMinor: 700,
      minCashMinor: 400, minCashDay: 2, collectedMinor: 1_200, unpaidCommitmentsMinor: 350,
      sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] },
    })
  })
})
