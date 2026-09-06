import { describe, expect, it } from 'vitest'
import { demoDefinition } from '../../src/trade/definition.js'
import { RulesDecisionProvider } from '../../src/trade/rules.js'
import type { Order, Supplier } from '../../src/trade/state.js'

const roster = [
  { slaveName: 'Sonia', departmentName: 'Sales' },
  { slaveName: 'Pete', departmentName: 'Purchasing' },
  { slaveName: 'Olga', departmentName: 'Operations' },
  { slaveName: 'Fin', departmentName: 'Finance' },
]

describe('the policy-B hedge orders its fast purchases by due day, then id (fix wave, Minor #8)', () => {
  it('funds the sooner-due order first when cash covers only one of the two hedges', () => {
    const definition = demoDefinition({ policy: 'B', seed: 1, roster, currency: 'USD' })
    const purchasing = definition.roles.find((r) => r.name === 'purchasing')
    if (purchasing === undefined) throw new Error('no purchasing role')
    const fast: Supplier = { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 }
    // Inserted FIRST but due LATER (day 20) -- the position a naive unsorted loop would favor.
    const lateOrder: Order = { id: 'lorder', qty: 12, remaining: 12, unitPriceMinor: 12_000, dueDay: 20, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' }
    // Inserted SECOND but due SOONER (day 10) -- the order the hedge must prioritize.
    const soonOrder: Order = { id: 'sorder', qty: 10, remaining: 10, unitPriceMinor: 12_000, dueDay: 10, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' }
    const provider = new RulesDecisionProvider(definition)
    // Cash covers exactly one of the two hedges (85,000 or 102,000) but not both (187,000).
    const actions = provider.decide({
      day: 0,
      role: purchasing,
      index: 1,
      observation: { inventory: 0, cashMinor: 150_000, orders: [lateOrder, soonOrder], purchases: [], suppliers: [fast], dailyShipCapacity: 30 },
    })
    const hedges = actions.filter((a) => a.type === 'place_purchase' && a.params['supplierId'] === 'fast')
    expect(hedges).toHaveLength(1)
    expect(hedges[0]?.refs).toEqual(['sorder'])
    expect(hedges[0]?.params['qty']).toBe(10)
  })
})
