import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from '../../src/core/action.js'
import type { RoleDefinition } from '../../src/core/sector.js'
import { tradeModel } from '../../src/trade/model.js'
import type { TradeState } from '../../src/trade/state.js'

const suppliers = [
  { id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 },
  { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 },
]
function base(over: Partial<TradeState> = {}): TradeState {
  return { cashMinor: 5_000_000, inventory: 100, dailyShipCapacity: 30, shippedToday: 0, minCashMinor: 5_000_000, minCashDay: 0, nextId: 1, pendingDemand: [], orders: [], purchases: [], suppliers, ...over }
}
const role = (name: string, allowed: string[], constraints: Record<string, number> = {}): RoleDefinition => ({ name, purpose: 't', observes: ['inventory', 'cashMinor', 'orders', 'purchases', 'suppliers', 'pendingDemand', 'dailyShipCapacity'], allowedActions: allowed, constraints, slaveName: 'x' })
const sales = role('sales', ['accept_order'])
const purchasing = role('purchasing', ['place_purchase'], { maxPurchaseQty: 500 })
const operations = role('operations', ['ship_order'])
const act = (type: string, params: Record<string, unknown>): ActionEnvelope => ({ type, params, rationale: 't', refs: [] })

describe('trade events', () => {
  it('demand becomes a pending order; accept_order turns it into an open order', () => {
    const d = tradeModel.applyEvent(base(), { type: 'demand', qty: 150, unitPriceMinor: 12_000, dueInDays: 10, collectInDays: 15 }, 1)
    expect(d.state.pendingDemand).toEqual([{ id: 'demand-1', qty: 150, unitPriceMinor: 12_000, dueDay: 11, collectInDays: 15 }])
    expect(tradeModel.validate(d.state, sales, act('accept_order', { orderId: 'demand-9' }))).toEqual({ ok: false, reason: { kind: 'unknown_reference', id: 'demand-9' } })
    const a = tradeModel.apply(d.state, sales, act('accept_order', { orderId: 'demand-1' }), 1)
    expect(a.state.pendingDemand).toEqual([])
    expect(a.state.orders[0]).toMatchObject({ id: 'order-2', qty: 150, remaining: 150, dueDay: 11, status: 'open' })
  })
  it('a purchase raises stock only on its delivery event, and cash only on payment_due', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }), 1)
    expect(p.state.inventory).toBe(100)
    expect(p.state.cashMinor).toBe(5_000_000)
    expect(p.state.purchases[0]).toMatchObject({ id: 'purchase-1', supplierId: 'normal', qty: 50, unitPriceMinor: 6_000, expectedDay: 8, payDay: 31, status: 'ordered', paid: false })
    expect(p.schedule).toEqual([
      { time: 8, priority: 'scheduled', event: { type: 'delivery', purchaseId: 'purchase-1' } },
      { time: 31, priority: 'scheduled', event: { type: 'payment_due', purchaseId: 'purchase-1' } },
    ])
    const delivered = tradeModel.applyEvent(p.state, { type: 'delivery', purchaseId: 'purchase-1' }, 8)
    expect(delivered.state.inventory).toBe(150)
    expect(delivered.state.purchases[0]?.status).toBe('delivered')
    const paid = tradeModel.applyEvent(delivered.state, { type: 'payment_due', purchaseId: 'purchase-1' }, 31)
    expect(paid.state.cashMinor).toBe(5_000_000 - 300_000)
    expect(paid.state.purchases[0]?.paid).toBe(true)
  })
  it('pay first, then deliver — order of events must not matter for delivery', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'fast', qty: 50 }), 1)
    expect(p.state.purchases[0]?.payDay).toBe(1) // paymentTermDays: 0
    expect(p.state.purchases[0]?.expectedDay).toBe(3) // leadDays: 2
    const paid = tradeModel.applyEvent(p.state, { type: 'payment_due', purchaseId: 'purchase-1' }, 1)
    expect(paid.state.cashMinor).toBe(5_000_000 - 425_000) // fast: 50 × 8500
    expect(paid.state.purchases[0]?.paid).toBe(true)
    expect(paid.state.inventory).toBe(100) // not yet delivered
    const delivered = tradeModel.applyEvent(paid.state, { type: 'delivery', purchaseId: 'purchase-1' }, 3)
    expect(delivered.state.inventory).toBe(150) // delivery happens despite being paid
    expect(delivered.state.purchases[0]?.status).toBe('delivered')
    expect(delivered.state.purchases[0]?.paid).toBe(true)
  })
  it('a supplier delay pushes every undelivered purchase of that supplier and reschedules its delivery', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }), 1)
    const delayed = tradeModel.applyEvent(p.state, { type: 'supplier_delay', supplierId: 'normal', extraDays: 6 }, 3)
    expect(delayed.state.purchases[0]?.expectedDay).toBe(14)
    expect(delayed.schedule).toEqual([{ time: 14, priority: 'scheduled', event: { type: 'delivery', purchaseId: 'purchase-1' } }])
    // The old day-8 delivery still fires; a delivery before `expectedDay` is ignored, not applied twice.
    const early = tradeModel.applyEvent(delayed.state, { type: 'delivery', purchaseId: 'purchase-1' }, 8)
    expect(early.state.inventory).toBe(100)
    expect(early.record).toMatchObject({ ignored: 'before_expected_day' })
  })
})

describe('trade rules', () => {
  it('refuses a purchase the cash minus unpaid commitments cannot cover', () => {
    const state = base({ cashMinor: 400_000, purchases: [{ id: 'purchase-1', supplierId: 'fast', qty: 20, unitPriceMinor: 8_500, orderedDay: 0, expectedDay: 2, deliveredDay: null, payDay: 0, status: 'ordered', paid: false }] })
    // 400_000 - 170_000 unpaid = 230_000 available; 50 × 6_000 = 300_000
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }))).toEqual({ ok: false, reason: { kind: 'insufficient_cash', availableMinor: 230_000, costMinor: 300_000 } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 30 })).ok).toBe(true)
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'nobody', qty: 1 }))).toEqual({ ok: false, reason: { kind: 'unknown_reference', id: 'nobody' } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 501 }))).toEqual({ ok: false, reason: { kind: 'over_constraint', constraint: 'maxPurchaseQty', max: 500 } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 0 }))).toMatchObject({ ok: false, reason: { kind: 'schema_invalid' } })
  })
  it('ships only what stock, capacity and the order allow', () => {
    const order = { id: 'order-1', qty: 150, remaining: 150, unitPriceMinor: 12_000, dueDay: 11, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' as const }
    const state = base({ inventory: 40, orders: [order] })
    expect(tradeModel.validate(state, operations, act('ship_order', { orderId: 'order-1', qty: 41 }))).toEqual({ ok: false, reason: { kind: 'insufficient_stock', inventory: 40 } })
    expect(tradeModel.validate(state, operations, act('ship_order', { orderId: 'order-1', qty: 31 }))).toEqual({ ok: false, reason: { kind: 'capacity_exhausted', remainingCapacity: 30 } })
    const small = base({ inventory: 100, orders: [{ ...order, qty: 20, remaining: 20 }] })
    expect(tradeModel.validate(small, operations, act('ship_order', { orderId: 'order-1', qty: 21 }))).toEqual({ ok: false, reason: { kind: 'over_shipment', remaining: 20 } })
    const shipped = tradeModel.apply(state, operations, act('ship_order', { orderId: 'order-1', qty: 30 }), 5)
    expect(shipped.state.inventory).toBe(10)
    expect(shipped.state.shippedToday).toBe(30)
    expect(shipped.state.orders[0]).toMatchObject({ remaining: 120, shippedQty: 30, lastShipDay: 5, status: 'partially_shipped' })
    expect(shipped.schedule).toEqual([{ time: 20, priority: 'scheduled', event: { type: 'collection', orderId: 'order-1', qty: 30 } }])
    const collected = tradeModel.applyEvent(shipped.state, { type: 'collection', orderId: 'order-1', qty: 30 }, 20)
    expect(collected.state.cashMinor).toBe(5_000_000 + 360_000)
  })
  it('the close resets capacity, tracks minimum cash and marks the order late past its due day', () => {
    const order = { id: 'order-1', qty: 10, remaining: 10, unitPriceMinor: 12_000, dueDay: 4, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' as const }
    const closed = tradeModel.closeDay(base({ shippedToday: 30, cashMinor: 100, orders: [order] }), 5)
    expect(closed.state.shippedToday).toBe(0)
    expect(closed.state.minCashMinor).toBe(100)
    expect(closed.state.minCashDay).toBe(5)
    expect(closed.record).toEqual({ inventory: 100, cashMinor: 100, openOrders: 1, lateOrders: 1 })
  })
  it('observe hands a role only the fields it may see', () => {
    const narrow: RoleDefinition = { ...sales, observes: ['inventory'] }
    expect(Object.keys(tradeModel.observe(base(), narrow))).toEqual(['inventory'])
  })
})
