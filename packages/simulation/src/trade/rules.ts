import type { ActionEnvelope } from '../core/action.js'
import type { DecisionProvider, DecisionRequest } from '../decide/provider.js'
import type { TradeSimulationDefinition } from './definition.js'
import type { Order, PendingDemand, Purchase, Supplier } from './state.js'

const envelope = (type: string, params: Record<string, unknown>, rationale: string, refs: string[] = []): ActionEnvelope => ({ type, params, rationale, refs })

/**
 * The rules provider (spec §5.4). Deterministic, policy-parameterized, reads only the
 * observation it is handed. Policy A: buy the shortfall from `normal` and wait. Policy B: as A,
 * plus hedge the at-risk remainder from `fast` when cash allows. Neither is "the AI"; the UI
 * says `rules provider`.
 */
export class RulesDecisionProvider implements DecisionProvider {
  readonly kind = 'rules' as const
  constructor(private readonly definition: TradeSimulationDefinition) {}

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    const o = request.observation
    switch (request.role.name) {
      case 'sales':
        return ((o['pendingDemand'] as PendingDemand[] | undefined) ?? []).map((d) => envelope('accept_order', { orderId: d.id }, `demand ${d.id} for ${d.qty} due day ${d.dueDay}`, [d.id]))
      case 'purchasing':
        return this.purchasing(request.day, o)
      case 'operations':
        return this.operations(o)
      case 'finance': {
        const cash = Number(o['cashMinor'] ?? 0)
        const unpaid = ((o['purchases'] as Purchase[] | undefined) ?? []).filter((p) => !p.paid).reduce((s, p) => s + p.qty * p.unitPriceMinor, 0)
        return [envelope('note', { text: `cash ${cash} minor, unpaid commitments ${unpaid} minor` }, 'daily cash watch')]
      }
      default:
        return []
    }
  }

  private purchasing(day: number, o: Readonly<Record<string, unknown>>): ActionEnvelope[] {
    const inventory = Number(o['inventory'] ?? 0)
    const cash = Number(o['cashMinor'] ?? 0)
    const capacity = Math.max(1, Number(o['dailyShipCapacity'] ?? 1))
    const orders = ((o['orders'] as Order[] | undefined) ?? []).filter((x) => x.status !== 'shipped')
    const purchases = (o['purchases'] as Purchase[] | undefined) ?? []
    const suppliers = (o['suppliers'] as Supplier[] | undefined) ?? []
    const normal = suppliers.find((s) => s.id === 'normal')
    const fast = suppliers.find((s) => s.id === 'fast')
    const inbound = purchases.filter((p) => p.status === 'ordered')
    const unpaid = purchases.filter((p) => !p.paid).reduce((s, p) => s + p.qty * p.unitPriceMinor, 0)
    let available = cash - unpaid
    const actions: ActionEnvelope[] = []
    const remaining = orders.reduce((s, x) => s + x.remaining, 0)
    const inboundQty = inbound.reduce((s, p) => s + p.qty, 0)
    const shortfall = remaining - inventory - inboundQty
    let normalQty = 0
    let normalExpectedDay = 0
    if (shortfall > 0 && normal !== undefined && available >= shortfall * normal.unitPriceMinor) {
      normalQty = shortfall
      normalExpectedDay = day + normal.leadDays
      actions.push(envelope('place_purchase', { supplierId: 'normal', qty: shortfall }, `shortfall ${shortfall} against open orders`, orders.map((x) => x.id)))
      available -= shortfall * normal.unitPriceMinor
    }
    if (this.definition.policy === 'B' && fast !== undefined) {
      let stock = inventory
      let inboundAfterHedge = [...inbound]
      // Include the normal purchase we just placed in the hedge simulation
      if (normalQty > 0) {
        inboundAfterHedge = [...inboundAfterHedge, { id: `pending-normal`, supplierId: 'normal', qty: normalQty, unitPriceMinor: normal!.unitPriceMinor, orderedDay: day, expectedDay: normalExpectedDay, deliveredDay: null, payDay: day + normal!.paymentTermDays, status: 'ordered' as const, paid: false }]
      }
      for (const order of orders) {
        const fromStock = Math.min(stock, order.remaining)
        stock -= fromStock
        let uncovered = order.remaining - fromStock
        if (uncovered <= 0) continue
        const safe = inboundAfterHedge.filter((p) => p.expectedDay + Math.ceil(uncovered / capacity) <= order.dueDay)
        for (const p of safe) {
          const take = Math.min(p.qty, uncovered)
          uncovered -= take
          inboundAfterHedge = inboundAfterHedge.map((q) => (q.id === p.id ? { ...q, qty: q.qty - take } : q)).filter((q) => q.qty > 0)
          if (uncovered === 0) break
        }
        if (uncovered > 0 && day + fast.leadDays <= order.dueDay && available >= uncovered * fast.unitPriceMinor) {
          actions.push(envelope('place_purchase', { supplierId: 'fast', qty: uncovered }, `order ${order.id} at risk: ${uncovered} uncovered by day ${order.dueDay}`, [order.id]))
          available -= uncovered * fast.unitPriceMinor
        }
      }
    }
    return actions
  }

  private operations(o: Readonly<Record<string, unknown>>): ActionEnvelope[] {
    let inventory = Number(o['inventory'] ?? 0)
    let capacity = Number(o['dailyShipCapacity'] ?? 0) - Number(o['shippedToday'] ?? 0)
    const orders = ((o['orders'] as Order[] | undefined) ?? []).filter((x) => x.status !== 'shipped').sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id))
    const actions: ActionEnvelope[] = []
    for (const order of orders) {
      const qty = Math.min(order.remaining, inventory, capacity)
      if (qty <= 0) continue
      actions.push(envelope('ship_order', { orderId: order.id, qty }, `ship ${qty} of ${order.remaining} due day ${order.dueDay}`, [order.id]))
      inventory -= qty
      capacity -= qty
    }
    return actions
  }
}
