import type { ActionEnvelope } from '../core/action.js'
import type { Applied, RoleDefinition, SectorModel } from '../core/sector.js'
import { acceptOrderParams, noteParams, placePurchaseParams, shipOrderParams, type TradeRejection } from './actions.js'
import { tradeEventSchema, tradeExternalEventSchema, type TradeEvent } from './events.js'
import { unpaidCommitmentsMinor, type Order, type TradeState } from './state.js'

type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: TradeRejection }
const ok: Verdict = { ok: true }
const no = (reason: TradeRejection): Verdict => ({ ok: false, reason })

function nextId(state: TradeState, prefix: string): { readonly id: string; readonly state: TradeState } {
  return { id: `${prefix}-${state.nextId}`, state: { ...state, nextId: state.nextId + 1 } }
}

function validate(state: TradeState, role: RoleDefinition, action: ActionEnvelope): Verdict {
  switch (action.type) {
    case 'note':
      return noteParams.safeParse(action.params).success ? ok : no({ kind: 'schema_invalid', detail: 'note needs { text }' })
    case 'accept_order': {
      const p = acceptOrderParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'accept_order needs { orderId }' })
      return state.pendingDemand.some((d) => d.id === p.data.orderId) ? ok : no({ kind: 'unknown_reference', id: p.data.orderId })
    }
    case 'place_purchase': {
      const p = placePurchaseParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'place_purchase needs { supplierId, qty ≥ 1 }' })
      const supplier = state.suppliers.find((s) => s.id === p.data.supplierId)
      if (supplier === undefined) return no({ kind: 'unknown_reference', id: p.data.supplierId })
      const max = role.constraints['maxPurchaseQty']
      if (max !== undefined && p.data.qty > max) return no({ kind: 'over_constraint', constraint: 'maxPurchaseQty', max })
      const costMinor = p.data.qty * supplier.unitPriceMinor
      const availableMinor = state.cashMinor - unpaidCommitmentsMinor(state)
      return availableMinor >= costMinor ? ok : no({ kind: 'insufficient_cash', availableMinor, costMinor })
    }
    case 'ship_order': {
      const p = shipOrderParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'ship_order needs { orderId, qty ≥ 1 }' })
      const order = state.orders.find((o) => o.id === p.data.orderId)
      if (order === undefined) return no({ kind: 'unknown_reference', id: p.data.orderId })
      if (order.status === 'shipped') return no({ kind: 'order_not_open', orderId: order.id })
      if (p.data.qty > order.remaining) return no({ kind: 'over_shipment', remaining: order.remaining })
      if (p.data.qty > state.inventory) return no({ kind: 'insufficient_stock', inventory: state.inventory })
      const remainingCapacity = state.dailyShipCapacity - state.shippedToday
      if (p.data.qty > remainingCapacity) return no({ kind: 'capacity_exhausted', remainingCapacity })
      return ok
    }
    default:
      return no({ kind: 'unknown_action', type: action.type })
  }
}

function apply(state: TradeState, _role: RoleDefinition, action: ActionEnvelope, day: number): Applied<TradeState, TradeEvent> {
  switch (action.type) {
    case 'accept_order': {
      const { orderId } = acceptOrderParams.parse(action.params)
      const demand = state.pendingDemand.find((d) => d.id === orderId)
      if (demand === undefined) return { state, schedule: [] }
      const next = nextId(state, 'order')
      const order: Order = { id: next.id, qty: demand.qty, remaining: demand.qty, unitPriceMinor: demand.unitPriceMinor, dueDay: demand.dueDay, collectInDays: demand.collectInDays, shippedQty: 0, lastShipDay: null, status: 'open' }
      return { state: { ...next.state, pendingDemand: state.pendingDemand.filter((d) => d.id !== orderId), orders: [...state.orders, order] }, schedule: [], record: { orderId: order.id, qty: order.qty } }
    }
    case 'place_purchase': {
      const { supplierId, qty } = placePurchaseParams.parse(action.params)
      const supplier = state.suppliers.find((s) => s.id === supplierId)
      if (supplier === undefined) return { state, schedule: [] }
      const next = nextId(state, 'purchase')
      const expectedDay = day + supplier.leadDays
      const payDay = day + supplier.paymentTermDays
      const purchase = { id: next.id, supplierId, qty, unitPriceMinor: supplier.unitPriceMinor, orderedDay: day, expectedDay, deliveredDay: null, payDay, status: 'ordered' as const, paid: false }
      return {
        state: { ...next.state, purchases: [...state.purchases, purchase] },
        schedule: [
          { time: expectedDay, priority: 'scheduled', event: { type: 'delivery', purchaseId: purchase.id } },
          { time: payDay, priority: 'scheduled', event: { type: 'payment_due', purchaseId: purchase.id } },
        ],
        record: { purchaseId: purchase.id, costMinor: qty * supplier.unitPriceMinor, expectedDay },
      }
    }
    case 'ship_order': {
      const { orderId, qty } = shipOrderParams.parse(action.params)
      const orders = state.orders.map((o) => {
        if (o.id !== orderId) return o
        const remaining = o.remaining - qty
        return { ...o, remaining, shippedQty: o.shippedQty + qty, lastShipDay: day, status: remaining === 0 ? ('shipped' as const) : ('partially_shipped' as const) }
      })
      const order = state.orders.find((o) => o.id === orderId)
      const collectDay = day + (order?.collectInDays ?? 0)
      return { state: { ...state, inventory: state.inventory - qty, shippedToday: state.shippedToday + qty, orders }, schedule: [{ time: collectDay, priority: 'scheduled', event: { type: 'collection', orderId, qty } }], record: { shipped: qty, collectDay } }
    }
    default:
      return { state, schedule: [], record: { text: String(action.params['text'] ?? '') } }
  }
}

function applyEvent(state: TradeState, event: TradeEvent, day: number): Applied<TradeState, TradeEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  switch (event.type) {
    case 'demand': {
      const next = nextId(state, 'demand')
      const demand = { id: next.id, qty: event.qty, unitPriceMinor: event.unitPriceMinor, dueDay: day + event.dueInDays, collectInDays: event.collectInDays }
      return { state: { ...next.state, pendingDemand: [...state.pendingDemand, demand] }, schedule: [], record: { demandId: demand.id, dueDay: demand.dueDay } }
    }
    case 'supplier_delay': {
      const affected = state.purchases.filter((p) => p.supplierId === event.supplierId && p.status === 'ordered' && p.expectedDay >= day)
      const purchases = state.purchases.map((p) => (affected.includes(p) ? { ...p, expectedDay: p.expectedDay + event.extraDays } : p))
      return { state: { ...state, purchases }, schedule: affected.map((p) => ({ time: p.expectedDay + event.extraDays, priority: 'scheduled' as const, event: { type: 'delivery' as const, purchaseId: p.id } })), record: { delayed: affected.map((p) => p.id), extraDays: event.extraDays } }
    }
    case 'delivery': {
      const purchase = state.purchases.find((p) => p.id === event.purchaseId)
      if (purchase === undefined || purchase.status !== 'ordered') return { state, schedule: [], record: { ignored: 'not_ordered', purchaseId: event.purchaseId } }
      if (day < purchase.expectedDay) return { state, schedule: [], record: { ignored: 'before_expected_day', purchaseId: purchase.id, expectedDay: purchase.expectedDay } }
      const purchases = state.purchases.map((p) => (p.id === purchase.id ? { ...p, deliveredDay: day, status: 'delivered' as const } : p))
      return { state: { ...state, inventory: state.inventory + purchase.qty, purchases }, schedule: [], record: { purchaseId: purchase.id, qty: purchase.qty } }
    }
    case 'payment_due': {
      const purchase = state.purchases.find((p) => p.id === event.purchaseId)
      if (purchase === undefined || purchase.paid) return { state, schedule: [], record: { ignored: 'already_paid', purchaseId: event.purchaseId } }
      const amount = purchase.qty * purchase.unitPriceMinor
      const purchases = state.purchases.map((p) => (p.id === purchase.id ? { ...p, paid: true } : p))
      return { state: { ...state, cashMinor: state.cashMinor - amount, purchases }, schedule: [], record: { purchaseId: purchase.id, paidMinor: amount } }
    }
    case 'collection': {
      const order = state.orders.find((o) => o.id === event.orderId)
      if (order === undefined) return { state, schedule: [], record: { ignored: 'unknown_order', orderId: event.orderId } }
      const amount = event.qty * order.unitPriceMinor
      return { state: { ...state, cashMinor: state.cashMinor + amount }, schedule: [], record: { orderId: order.id, collectedMinor: amount } }
    }
  }
}

function closeDay(state: TradeState, day: number): Applied<TradeState, TradeEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  const minCash = state.cashMinor < state.minCashMinor ? { minCashMinor: state.cashMinor, minCashDay: day } : {}
  const openOrders = state.orders.filter((o) => o.status !== 'shipped').length
  const lateOrders = state.orders.filter((o) => o.status !== 'shipped' && day > o.dueDay).length
  return { state: { ...state, shippedToday: 0, ...minCash }, schedule: [], record: { inventory: state.inventory, cashMinor: state.cashMinor, openOrders, lateOrders } }
}

function observe(state: TradeState, role: RoleDefinition): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of role.observes) if (key in state) out[key] = (state as unknown as Record<string, unknown>)[key]
  return out
}

/** The trade sector (spec §5): one product, cash, orders, purchases, two suppliers, capacity. */
export const tradeModel: SectorModel<TradeState, TradeEvent, TradeRejection> = {
  name: 'trade',
  eventSchema: tradeEventSchema,
  externalEventSchema: tradeExternalEventSchema as unknown as SectorModel<TradeState, TradeEvent, TradeRejection>['externalEventSchema'],
  observe,
  validate,
  apply,
  applyEvent,
  closeDay,
}
